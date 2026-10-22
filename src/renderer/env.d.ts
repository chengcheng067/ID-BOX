import type { ModVaultApi } from '../preload/index'

declare global {
  interface Window {
    modvault: ModVaultApi
  }
}

export {}
