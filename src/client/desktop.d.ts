export {};

declare global {
  interface Window {
    tutorDesktop?: {
      openBackupFolder: () => Promise<void>;
      chooseBackupFolder: () => Promise<string | null>;
    };
  }
}
