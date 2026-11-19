import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
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
  // Convert HEIC and bound large iPhone originals before uploading.
  const image = await manipulateAsync(asset.uri,
    Math.max(asset.width, asset.height) > 1024
      ? [{ resize: asset.width >= asset.height ? { width: 1024 } : { height: 1024 } }]
      : [], { compress: 0.8, format: SaveFormat.JPEG });
  const form = new FormData();
  if (Platform.OS === "web")
    form.append(
      "file",
      await (await fetch(image.uri)).blob(),
      "photo.jpg",
    );
  else
    form.append("file", {
      uri: image.uri,
      name: "photo.jpg",
      type: "image/jpeg",
    } as unknown as Blob);
  return form;
}
