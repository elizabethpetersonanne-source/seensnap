import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
/** Native crop UI; web picker retains its browser preview. Server validates bytes. */
export async function pickImageForm(): Promise<FormData | null> {
  if (Platform.OS !== "web") {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted)
      throw new Error("Allow photo access in Settings to choose a picture.");
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.8,
    exif: false,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  if (asset.fileSize && asset.fileSize > 6 * 1024 * 1024)
    throw new Error("Choose an image smaller than 6 MB.");
  const form = new FormData();
  if (Platform.OS === "web")
    form.append(
      "file",
      await (await fetch(asset.uri)).blob(),
      asset.fileName ?? "photo.jpg",
    );
  else
    form.append("file", {
      uri: asset.uri,
      name: asset.fileName ?? "photo.jpg",
      type: asset.mimeType ?? "image/jpeg",
    } as unknown as Blob);
  return form;
}
