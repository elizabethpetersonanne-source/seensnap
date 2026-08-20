import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";

/**
 * Platform-aware image picker.
 *
 * Native: expo-image-picker → photo library.
 * Web:    hidden <input type="file" accept="image/*"> click.
 *
 * The return shape is uniform so callers only branch when attaching to
 * FormData — RN's FormData accepts the `{ uri, name, type }` blob shape
 * on native; on web we hand back the real File so it can be appended
 * directly.
 */

export type PickedImage = {
  uri: string;
  fileName: string;
  mimeType: string;
  // Only populated on web. Native uses uri + name + type directly.
  webFile?: File;
};

async function pickOnNative(): Promise<PickedImage | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error("PERMISSION_DENIED");
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
  });
  if (result.canceled || !result.assets.length) return null;
  const asset = result.assets[0];
  return {
    uri: asset.uri,
    fileName: asset.fileName || `image-${Date.now()}.jpg`,
    mimeType: asset.mimeType || "image/jpeg",
  };
}

async function pickOnWeb(): Promise<PickedImage | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const cleanup = () => {
      document.body.removeChild(input);
    };
    input.addEventListener("change", () => {
      settled = true;
      const file = input.files?.[0];
      if (!file) {
        cleanup();
        resolve(null);
        return;
      }
      resolve({
        uri: URL.createObjectURL(file),
        fileName: file.name,
        mimeType: file.type || "image/jpeg",
        webFile: file,
      });
      cleanup();
    });
    // The file-picker cancel event isn't reliable across browsers, so also
    // resolve null on window focus if no file was picked within a beat.
    window.addEventListener(
      "focus",
      () => {
        setTimeout(() => {
          if (!settled) {
            cleanup();
            resolve(null);
          }
        }, 300);
      },
      { once: true },
    );
    input.click();
  });
}

export async function pickImageFromLibrary(): Promise<PickedImage | null> {
  if (Platform.OS === "web") return pickOnWeb();
  return pickOnNative();
}

/** Append a picked image to a FormData in the right shape for each platform. */
export function appendImageToFormData(
  form: FormData,
  field: string,
  picked: PickedImage,
): void {
  if (picked.webFile) {
    form.append(field, picked.webFile, picked.fileName);
    return;
  }
  form.append(field, {
    uri: picked.uri,
    name: picked.fileName,
    type: picked.mimeType,
  } as any);
}
