import { ClerkProvider } from "@clerk/nextjs";
import { Providers } from "@/components/providers";
export default function RoomOpsLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider appearance={{ variables: { colorPrimary: "#265784", borderRadius: "0.75rem" } }}>
    <Providers>{children}</Providers>
  </ClerkProvider>;
}
