export const STREAMING_SERVICES = [
  { id: "netflix", name: "Netflix", shortName: "N", logoText: "NETFLIX", color: "#E50914", textColor: "#FFFFFF" },
  { id: "prime_video", name: "Prime Video", shortName: "PV", logoText: "prime", color: "#00A8E1", textColor: "#FFFFFF" },
  { id: "apple_tv_plus", name: "Apple TV+", shortName: "TV+", logoText: "tv+", color: "#A2AAAD", textColor: "#08101D" },
  { id: "hbo_max", name: "Max", shortName: "MAX", logoText: "max", color: "#6C2BFF", textColor: "#FFFFFF" },
  { id: "disney_plus", name: "Disney+", shortName: "D+", logoText: "Disney+", color: "#113CCF", textColor: "#FFFFFF" },
  { id: "hulu", name: "Hulu", shortName: "H", logoText: "hulu", color: "#1CE783", textColor: "#08101D" },
  { id: "paramount_plus", name: "Paramount+", shortName: "P+", logoText: "Paramount+", color: "#0064FF", textColor: "#FFFFFF" },
  { id: "peacock", name: "Peacock", shortName: "PK", logoText: "Peacock", color: "#F5C518", textColor: "#08101D" },
] as const;

export type StreamingServiceId = (typeof STREAMING_SERVICES)[number]["id"];
export type StreamingServiceMeta = (typeof STREAMING_SERVICES)[number];

export type StreamingAvailability = {
  service: StreamingServiceId | string;
  serviceName: string;
  appUrl?: string | null;
  webUrl?: string | null;
  logoUrl?: string | null;
};

export function getStreamingServiceMeta(serviceId: string) {
  return STREAMING_SERVICES.find((service) => service.id === serviceId) ?? null;
}
