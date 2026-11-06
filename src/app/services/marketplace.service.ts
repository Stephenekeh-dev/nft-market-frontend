import { Injectable } from '@angular/core';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getMint
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import idl from '../../idl/nft_marketplace.json';

interface WalletProvider {
  publicKey?: PublicKey;
  connect(): Promise<{ publicKey?: PublicKey } | void>;
  disconnect(): Promise<void>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
}

declare global {
  interface Window {
    solana?: WalletProvider;
    solflare?: WalletProvider;
  }
}

export interface Listing {
  address: string;
  seller: string;
  mint: string;
  priceLamports: bigint;
  priceSol: string;
}

export interface OwnedNft {
  mint: string;
  tokenAccount: string;
}

export interface MarketplaceInfo {
  treasury: string;
  feePercent: string;
}

// Listing account: 8 discriminator + 32 seller + 32 mint + 8 price + 1 bump
const LISTING_SIZE = 81;
const LAMPORTS_PER_SOL = 1_000_000_000;

@Injectable({ providedIn: 'root' })
export class MarketplaceService {

  readonly rpcUrl = 'https://api.devnet.solana.com';
  readonly connection = new Connection(this.rpcUrl, 'confirmed');
  readonly programId = new PublicKey((idl as any).address);

  walletPublicKey: PublicKey | null = null;

  get provider(): WalletProvider | null {
    return window.solflare ?? window.solana ?? null;
  }

  // ---------------------------------------------------------------- wallet

  async connectWallet(): Promise<string> {
    const provider = this.provider;
    if (!provider) {
      throw new Error('No wallet found. Please install Solflare or Phantom.');
    }
    const response = await provider.connect();
    // Phantom returns { publicKey }; Solflare sets provider.publicKey instead.
    const publicKey = (response && (response as any).publicKey) ?? provider.publicKey;
    if (!publicKey) {
      throw new Error('Wallet connected but no public key was returned.');
    }
    this.walletPublicKey = publicKey;
    return publicKey.toBase58();
  }

  async disconnectWallet(): Promise<void> {
    try {
      await this.provider?.disconnect();
    } finally {
      this.walletPublicKey = null;
    }
  }

  async getSolBalance(): Promise<number> {
    this.requireWallet();
    const lamports = await this.connection.getBalance(this.walletPublicKey!, 'confirmed');
    return lamports / LAMPORTS_PER_SOL;
  }

  // ----------------------------------------------------------------- reads

  private marketplacePda(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from('marketplace')], this.programId)[0];
  }

  private listingPda(mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('listing'), mint.toBuffer()],
      this.programId
    )[0];
  }

  async getMarketplace(): Promise<MarketplaceInfo> {
    const info = await this.connection.getAccountInfo(this.marketplacePda());
    if (!info) {
      throw new Error('The marketplace has not been initialized on this network.');
    }
    // Marketplace: 8 discriminator + 32 admin + 32 treasury + 2 fee_bps + 1 bump
    const treasury = new PublicKey(info.data.subarray(40, 72)).toBase58();
    const feeBps = new DataView(info.data.buffer, info.data.byteOffset + 72, 2).getUint16(0, true);
    return { treasury, feePercent: (feeBps / 100).toString() };
  }

  async getListings(): Promise<Listing[]> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [{ dataSize: LISTING_SIZE }]
    });

    const discriminator = this.accountDiscriminator('Listing');
    const listings: Listing[] = [];

    for (const { pubkey, account } of accounts) {
      const data = account.data;
      if (discriminator && !this.bytesEqual(data.subarray(0, 8), discriminator)) continue;

      const seller = new PublicKey(data.subarray(8, 40)).toBase58();
      const mint = new PublicKey(data.subarray(40, 72)).toBase58();
      const price = new DataView(data.buffer, data.byteOffset + 72, 8).getBigUint64(0, true);

      listings.push({
        address: pubkey.toBase58(),
        seller,
        mint,
        priceLamports: price,
        priceSol: this.fromLamports(price)
      });
    }

    return listings.sort((a, b) => (a.priceLamports < b.priceLamports ? -1 : 1));
  }

  /** NFTs the connected wallet holds: 0 decimals, supply 1, mint authority revoked. */
  async getOwnedNfts(): Promise<OwnedNft[]> {
    this.requireWallet();
    const result = await this.connection.getParsedTokenAccountsByOwner(this.walletPublicKey!, {
      programId: TOKEN_PROGRAM_ID
    });

    const nfts: OwnedNft[] = [];
    for (const { pubkey, account } of result.value) {
      const info = (account.data as any).parsed?.info;
      if (!info) continue;
      const amount = info.tokenAmount;
      if (amount.decimals !== 0 || amount.amount !== '1') continue;

      const mint = new PublicKey(info.mint);
      const mintInfo = await getMint(this.connection, mint);
      if (mintInfo.supply === BigInt(1) && mintInfo.mintAuthority === null) {
        nfts.push({ mint: info.mint, tokenAccount: pubkey.toBase58() });
      }
    }
    return nfts;
  }

  // ---------------------------------------------------------- instructions

  async listNft(nft: OwnedNft, priceSol: string): Promise<string> {
    this.requireWallet();
    const seller = this.walletPublicKey!;
    const mint = new PublicKey(nft.mint);
    const lamports = this.toLamports(priceSol);
    if (lamports <= BigInt(0)) throw new Error('Enter a price greater than zero.');

    const listing = this.listingPda(mint);
    const escrow = getAssociatedTokenAddressSync(mint, listing, true);

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: seller, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: new PublicKey(nft.tokenAccount), isSigner: false, isWritable: true },
        { pubkey: listing, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: Buffer.concat([this.instructionDiscriminator('list_nft'), this.u64(lamports)])
    });

    return this.send([ix]);
  }

  async buyNft(item: Listing): Promise<string> {
    this.requireWallet();
    const buyer = this.walletPublicKey!;
    const mint = new PublicKey(item.mint);
    const seller = new PublicKey(item.seller);
    const marketplace = this.marketplacePda();
    const market = await this.getMarketplace();
    const treasury = new PublicKey(market.treasury);

    const listing = this.listingPda(mint);
    const escrow = getAssociatedTokenAddressSync(mint, listing, true);
    const buyerTokenAccount = getAssociatedTokenAddressSync(mint, buyer);

    // The program needs the buyer's token account to exist, so create it if missing.
    const createAta = createAssociatedTokenAccountIdempotentInstruction(
      buyer,
      buyerTokenAccount,
      buyer,
      mint
    );

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: buyer, isSigner: true, isWritable: true },
        { pubkey: seller, isSigner: false, isWritable: true },
        { pubkey: marketplace, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: listing, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: buyerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
      ],
      data: this.instructionDiscriminator('buy_nft')
    });

    return this.send([createAta, ix]);
  }

  async cancelListing(item: Listing): Promise<string> {
    this.requireWallet();
    const seller = this.walletPublicKey!;
    const mint = new PublicKey(item.mint);

    const listing = this.listingPda(mint);
    const escrow = getAssociatedTokenAddressSync(mint, listing, true);
    const sellerTokenAccount = getAssociatedTokenAddressSync(mint, seller);

    const createAta = createAssociatedTokenAccountIdempotentInstruction(
      seller,
      sellerTokenAccount,
      seller,
      mint
    );

    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: seller, isSigner: true, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: listing, isSigner: false, isWritable: true },
        { pubkey: escrow, isSigner: false, isWritable: true },
        { pubkey: sellerTokenAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
      ],
      data: this.instructionDiscriminator('cancel_listing')
    });

    return this.send([createAta, ix]);
  }

  // --------------------------------------------------------------- sending

  /** Fresh blockhash per attempt, preflight on, retry if it expired during approval. */
  private async send(instructions: TransactionInstruction[]): Promise<string> {
    const provider = this.provider;
    if (!provider) throw new Error('No wallet found.');

    const MAX_ATTEMPTS = 4;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

        const tx = new Transaction().add(...instructions);
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.walletPublicKey!;

        const signed = await provider.signTransaction(tx);

        const signature = await this.connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          preflightCommitment: 'confirmed'
        });

        const confirmed = await this.pollSignatureStatus(signature, 30_000);
        if (!confirmed) throw new Error('Blockhash not found or expired');
        return signature;

      } catch (error: any) {
        const msg: string = error?.message || '';
        const expired =
          msg.includes('Blockhash not found') ||
          msg.includes('block height exceeded') ||
          msg.includes('expired');

        if (expired && attempt < MAX_ATTEMPTS) {
          console.warn(`Blockhash expired (attempt ${attempt}). Retrying...`);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Transaction failed after multiple attempts.');
  }

  private async pollSignatureStatus(signature: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { value } = await this.connection.getSignatureStatuses([signature]);
      const status = value[0];
      if (status) {
        if (status.err) {
          throw new Error('Transaction failed on-chain: ' + JSON.stringify(status.err));
        }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return true;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return false;
  }

  // --------------------------------------------------------------- helpers

  private requireWallet(): void {
    if (!this.walletPublicKey) throw new Error('Connect your wallet first.');
  }

  private instructionDiscriminator(name: string): Buffer {
    const ix = (idl as any).instructions.find((i: any) => i.name === name);
    if (!ix) throw new Error(`Instruction "${name}" was not found in nft_marketplace.json`);
    return Buffer.from(ix.discriminator);
  }

  private accountDiscriminator(name: string): Buffer | null {
    const account = ((idl as any).accounts ?? []).find((a: any) => a.name === name);
    return account ? Buffer.from(account.discriminator) : null;
  }

  private bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private u64(value: bigint): Buffer {
    const bytes = Buffer.alloc(8);
    new DataView(bytes.buffer, bytes.byteOffset, 8).setBigUint64(0, value, true);
    return bytes;
  }

  private toLamports(sol: string): bigint {
    const clean = (sol ?? '').trim();
    if (!/^\d*\.?\d*$/.test(clean) || clean === '' || clean === '.') {
      throw new Error('Enter a valid price.');
    }
    const [whole, frac = ''] = clean.split('.');
    const fracPadded = (frac + '000000000').slice(0, 9);
    return BigInt(whole || '0') * BigInt(LAMPORTS_PER_SOL) + BigInt(fracPadded || '0');
  }

  private fromLamports(lamports: bigint): string {
    const whole = lamports / BigInt(LAMPORTS_PER_SOL);
    const frac = (lamports % BigInt(LAMPORTS_PER_SOL))
      .toString()
      .padStart(9, '0')
      .replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  }

  getProgramId(): string {
    return this.programId.toBase58();
  }
}
