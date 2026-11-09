/** Authenticated media on native and web, without credentials in image URLs. */
import { useEffect, useRef, useState } from "react";
import { Image, type ImageProps } from "react-native";
import { apiRequest, resolveMediaUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth";
export function ProtectedImage({ source, ...props }: ImageProps) {
  const { sessionToken } = useAuth();
  const onError = useRef(props.onError);
  onError.current = props.onError;
  const uri =
    source && !Array.isArray(source) && typeof source === "object"
      ? source.uri
      : undefined;
  const match = uri?.match(/(?:^|\/api\/v1)\/media-assets\/([0-9a-f-]{36})$/i);
  const id = match?.[1];
  const [loaded, setLoaded] = useState<{
    id: string;
    token: string;
    uri: string;
  } | null>(null);
  useEffect(() => {
    let active = true;
    setLoaded(null);
    if (id && sessionToken)
      void apiRequest<{ uri: string }>(`/media-assets/${id}/source`, {
        token: sessionToken,
      })
        .then((res) => {
          if (active) setLoaded({ id, token: sessionToken, uri: res.uri });
        })
        .catch(() => {
          if (active)
            onError.current?.({
              nativeEvent: { error: "Image unavailable" },
            } as Parameters<NonNullable<ImageProps["onError"]>>[0]);
        });
    return () => {
      active = false;
    };
  }, [id, sessionToken]);
  const safeSource = id
    ? loaded?.id === id && loaded.token === sessionToken
      ? { uri: loaded.uri }
      : undefined
    : uri
      ? { uri: resolveMediaUrl(uri) ?? uri }
      : source;
  return <Image {...props} source={safeSource} />;
}
