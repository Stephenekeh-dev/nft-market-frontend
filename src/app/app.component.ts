import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MarketplaceService, Listing, OwnedNft } from './services/marketplace.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnInit {
  tab: 'browse' | 'sell' = 'browse';

  walletAddress: string | null = null;
  solBalance: number | null = null;

  listings: Listing[] = [];
  myNfts: OwnedNft[] = [];
  prices: Record<string, string> = {};
  feePercent: string | null = null;

  busy = false;
  busyLabel = '';
  errorMessage: string | null = null;
  successMessage: string | null = null;
  lastSignature: string | null = null;

  constructor(private market: MarketplaceService) {}

  ngOnInit() {
    this.refreshListings();
  }

  get programId(): string {
    return this.market.getProgramId();
  }

  short(address: string): string {
    return address.slice(0, 4) + '...' + address.slice(-4);
  }

  isMine(item: Listing): boolean {
    return !!this.walletAddress && this.walletAddress === item.seller;
  }

  explorerTx(sig: string): string {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }

  explorerAddress(addr: string): string {
    return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
  }

  async setTab(tab: 'browse' | 'sell') {
    this.tab = tab;
    if (tab === 'sell' && this.walletAddress) {
      await this.run('Loading your NFTs...', async () => {
        this.myNfts = await this.market.getOwnedNfts();
      });
    }
  }

  async connect() {
    await this.run('Connecting wallet...', async () => {
      this.walletAddress = await this.market.connectWallet();
      this.solBalance = await this.market.getSolBalance();
    });
  }

  async disconnect() {
    await this.market.disconnectWallet();
    this.walletAddress = null;
    this.solBalance = null;
    this.myNfts = [];
    this.clearMessages();
  }

  async refreshListings() {
    await this.run('Loading listings...', async () => {
      const [listings, market] = await Promise.all([
        this.market.getListings(),
        this.market.getMarketplace().catch(() => null)
      ]);
      this.listings = listings;
      this.feePercent = market ? market.feePercent : null;
    });
  }

  async buy(item: Listing) {
    await this.run('Buying NFT...', async () => {
      this.lastSignature = await this.market.buyNft(item);
      this.successMessage = `Bought the NFT for ${item.priceSol} SOL.`;
      await this.reloadAll();
    });
  }

  async cancel(item: Listing) {
    await this.run('Cancelling listing...', async () => {
      this.lastSignature = await this.market.cancelListing(item);
      this.successMessage = 'Listing cancelled. The NFT is back in your wallet.';
      await this.reloadAll();
    });
  }

  async list(nft: OwnedNft) {
    await this.run('Listing NFT...', async () => {
      this.lastSignature = await this.market.listNft(nft, this.prices[nft.mint] ?? '');
      this.successMessage = 'NFT listed. It is now held in escrow by the program.';
      delete this.prices[nft.mint];
      await this.reloadAll();
    });
  }

  // ----------------------------------------------------------------- utils

  /** Refreshes listings, balance and the NFT list after any action. */
  private async reloadAll() {
    this.listings = await this.market.getListings();
    if (this.walletAddress) {
      this.solBalance = await this.market.getSolBalance();
      this.myNfts = await this.market.getOwnedNfts();
    }
  }

  private clearMessages() {
    this.errorMessage = null;
    this.successMessage = null;
    this.lastSignature = null;
  }

  private async run(label: string, action: () => Promise<void>) {
    this.clearMessages();
    this.busy = true;
    this.busyLabel = label;
    try {
      await action();
    } catch (error: any) {
      console.error(error);
      const msg: string = error?.message || 'Something went wrong.';
      this.errorMessage = /reject|cancel/i.test(msg)
        ? 'You cancelled the request in your wallet.'
        : msg;
    } finally {
      this.busy = false;
      this.busyLabel = '';
    }
  }
}
