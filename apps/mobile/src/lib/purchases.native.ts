import Constants from "expo-constants";
import { Platform } from "react-native";
import type { PurchasesPackage } from "react-native-purchases";

export type StorePackage = PurchasesPackage;
const apiKey = process.env.EXPO_PUBLIC_REVENUECAT_APPLE_KEY || "";
export const nativePurchasesAvailable = Platform.OS === "ios" && Constants.appOwnership !== "expo" && apiKey.startsWith("appl_");
let queue: Promise<unknown> = Promise.resolve();
let configured = false;

// Every operation binds to the signed-in SeenSnap UUID before touching the store.
// Serialize login + purchase/restore to prevent a concurrent account switch from
// changing the RevenueCat customer half way through an Apple purchase sheet.
function forUser<T>(userId: string, action: (sdk: typeof import("react-native-purchases").default) => Promise<T>): Promise<T> {
  const task = queue.catch(() => {}).then(async () => {
    if (!nativePurchasesAvailable || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Purchases are not available in this build.");
    const sdk = (await import("react-native-purchases")).default;
    if (!configured) {
      sdk.configure({ apiKey, appUserID: userId });
      configured = true;
    } else if (await sdk.getAppUserID() !== userId) {
      await sdk.logIn(userId);
    }
    return action(sdk);
  });
  queue = task;
  return task;
}

export function storePackages(userId: string, productIds: string[]): Promise<StorePackage[]> {
  return forUser(userId, async sdk => {
    const offering = (await sdk.getOfferings()).current;
    return (offering?.availablePackages || []).filter(pack => productIds.includes(pack.product.identifier)
      && ["P1M", "P1Y"].includes(pack.product.subscriptionPeriod || ""));
  });
}

export async function buyPackage(userId: string, pack: StorePackage): Promise<void> {
  await forUser(userId, sdk => sdk.purchasePackage(pack));
}

export async function restoreStorePurchases(userId: string): Promise<void> {
  await forUser(userId, sdk => sdk.restorePurchases());
}
