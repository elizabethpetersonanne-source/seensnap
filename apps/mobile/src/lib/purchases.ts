/** Web has no native store. Never load a native purchase module in its bundle. */
import type { PurchasesPackage } from "react-native-purchases";
export type StorePackage = PurchasesPackage;
export const nativePurchasesAvailable = false;
export async function storePackages(_userId: string, _products: string[]): Promise<StorePackage[]> { return []; }
export async function buyPackage(_userId: string, _pack: StorePackage): Promise<void> { throw new Error("Purchases are available in the iPhone and iPad app."); }
export async function restoreStorePurchases(_userId: string): Promise<void> { throw new Error("Restore purchases in the iPhone or iPad app."); }
