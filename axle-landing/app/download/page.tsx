import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpRight, Monitor, Terminal } from "lucide-react";
import { PageHero } from "@/components/site/page-hero";
import { AppleIcon } from "@/components/site/logo";
import { Button } from "@/components/ui/button";
import { Reveal, RevealGroup, RevealItem } from "@/components/fx/reveal";
import { SITE } from "@/lib/site";

export const metadata: Metadata = {
  title: "Download",
  description: "Get the desktop workspace for macOS, Windows, or Linux. Choose the build for your computer.",
};

export default function DownloadPage() {
  return (
    <>
      <PageHero
        eyebrow="Download Axle"
        title={<>Your next idea.<br /><span className="text-mute">Right at home.</span></>}
        copy="Bring your code, your models, and your tools together. Choose the desktop build for your computer and make it yours."
      >
        <p className="flex items-center gap-2.5 text-sm text-mute"><span className="h-1.5 w-1.5 rounded-full bg-white/60" />Free to download. Bring your own model provider when you are ready.</p>
      </PageHero>

      <section className="px-6 pb-24 sm:pb-32" aria-label="Choose your operating system">
        <div className="mx-auto max-w-7xl">
          <RevealGroup className="grid gap-4 lg:grid-cols-3">
            <RevealItem className="h-full">
              <article className="flex h-full flex-col rounded-[24px] border border-white/[0.12] bg-white/[0.025] p-7 sm:p-9">
                <AppleIcon className="mb-9 h-9 w-9" />
                <h2 className="text-[25px] font-medium tracking-[-0.035em]">macOS</h2>
                <p className="mt-2 mb-8 text-sm leading-6 text-mute">A workspace that feels at home on your Mac.</p>
                <div className="mt-auto space-y-3">
                  <Button href={SITE.download + "?platform=macos-arm64"} className="w-full justify-between" ariaLabel="Download macOS disk image for Apple silicon">
                    Apple silicon <ArrowDownToLine size={17} />
                  </Button>
                  <Button href={SITE.download + "?platform=macos-x64"} variant="secondary" className="w-full justify-between" ariaLabel="Download macOS disk image for Intel">
                    Intel <ArrowDownToLine size={17} />
                  </Button>
                </div>
                <p className="mt-5 text-xs leading-5 text-mute">.dmg installer · arm64 or x64</p>
              </article>
            </RevealItem>
            <RevealItem className="h-full">
              <article className="flex h-full flex-col rounded-[24px] border border-white/[0.08] bg-white/[0.015] p-7 sm:p-9">
                <Monitor size={33} strokeWidth={1.5} className="mb-9" />
                <h2 className="text-[25px] font-medium tracking-[-0.035em]">Windows</h2>
                <p className="mt-2 mb-8 text-sm leading-6 text-mute">Everything you need, in one desktop workspace.</p>
                <Button href={SITE.download + "?platform=windows-x64"} variant="secondary" className="mt-auto w-full justify-between" ariaLabel="Download Windows x64 installer">
                  Download .exe <ArrowDownToLine size={17} />
                </Button>
                <p className="mt-5 text-xs leading-5 text-mute">.exe installer · x64</p>
              </article>
            </RevealItem>
            <RevealItem className="h-full">
              <article className="flex h-full flex-col rounded-[24px] border border-white/[0.08] bg-white/[0.015] p-7 sm:p-9">
                <Terminal size={33} strokeWidth={1.5} className="mb-9" />
                <h2 className="text-[25px] font-medium tracking-[-0.035em]">Linux</h2>
                <p className="mt-2 mb-8 text-sm leading-6 text-mute">Built for the way you like to work.</p>
                <Button href={SITE.download + "?platform=linux-x64&format=appimage"} variant="secondary" className="mt-auto w-full justify-between" ariaLabel="Download Linux x64 AppImage">
                  Download AppImage <ArrowDownToLine size={17} />
                </Button>
                <p className="mt-5 text-xs leading-5 text-mute">AppImage · x64</p>
              </article>
            </RevealItem>
          </RevealGroup>

          <Reveal>
            <div className="mt-10 flex flex-col gap-5 border-t border-white/[0.08] pt-7 text-sm text-mute sm:flex-row sm:items-center sm:justify-between">
              <p>Looking for another build or release notes?</p>
              <a href={SITE.releases} className="inline-flex items-center gap-2 text-paper underline decoration-white/20 underline-offset-4 transition-colors duration-[400ms] hover:decoration-white/70" target="_blank" rel="noopener noreferrer">Browse GitHub releases <ArrowUpRight size={15} /></a>
            </div>
          </Reveal>

          <Reveal>
            <div className="mt-20 grid gap-6 rounded-[24px] border border-white/[0.08] p-7 sm:grid-cols-[1fr_auto] sm:items-center sm:p-9">
              <div>
                <h2 className="text-xl font-medium tracking-[-0.025em]">A little setup. A lot of possibility.</h2>
                <p className="mt-3 max-w-xl text-sm leading-6 text-mute">Install the app, open a project, and connect a model in Settings. Our guide walks you through the first few minutes.</p>
              </div>
              <Button href="/docs" variant="secondary">Get started <ArrowUpRight size={17} /></Button>
            </div>
            <p className="mt-6 text-center text-xs leading-6 text-mute">Learn about <Link href="/legal/privacy" className="underline underline-offset-4">privacy</Link> and <Link href="/legal/terms" className="underline underline-offset-4">licensing</Link> before you get started.</p>
          </Reveal>
        </div>
      </section>
    </>
  );
}
