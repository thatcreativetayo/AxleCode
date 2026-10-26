import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, FileText } from "lucide-react";
import { Reveal } from "@/components/fx/reveal";
import { SITE } from "@/lib/site";

export type LegalSection = {
  id: string;
  heading: string;
  paragraphs: ReactNode[];
  bullets?: ReactNode[];
  links?: { label: string; href: string }[];
};

export function LegalPage({
  eyebrow, title, updated, intro, sections,
}: {
  eyebrow: string;
  title: string;
  updated: string;
  intro: string;
  sections: LegalSection[];
}) {
  return (
    <div className="px-6 pt-36 pb-24 sm:pt-44 sm:pb-32">
      <div className="mx-auto max-w-7xl">
        <Reveal>
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-mute">{eyebrow}</p>
          <h1 className="mt-6 text-[38px] font-medium leading-[1.08] tracking-[-0.04em] sm:text-[54px]">{title}</h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-mute">{intro}</p>
          <p className="mt-6 text-xs text-mute">Updated {updated}</p>
        </Reveal>

        <div className="mt-14 grid items-start gap-12 border-t border-white/[0.08] pt-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-20">
          <aside className="lg:sticky lg:top-32">
            <nav aria-label="Legal information" className="flex flex-wrap gap-x-5 gap-y-3 lg:flex-col">
              <Link href="/legal/privacy" className="text-sm text-mute transition-colors duration-[400ms] hover:text-paper">Privacy & data</Link>
              <Link href="/legal/terms" className="text-sm text-mute transition-colors duration-[400ms] hover:text-paper">Terms & licensing</Link>
              <Link href="/legal/security" className="text-sm text-mute transition-colors duration-[400ms] hover:text-paper">Security</Link>
            </nav>
            <div className="mt-8 hidden border-t border-white/[0.08] pt-7 lg:block">
              <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.13em] text-mute">On this page</p>
              <nav aria-label="On this page" className="flex flex-col gap-3">
                {sections.map((section) => <a key={section.id} href={"#" + section.id} className="text-[13px] leading-5 text-mute transition-colors duration-[400ms] hover:text-paper">{section.heading}</a>)}
              </nav>
            </div>
          </aside>

          <div className="max-w-3xl">
            <div className="space-y-12">
              {sections.map((section, index) => (
                <Reveal key={section.id}>
                  <section id={section.id} className="scroll-mt-32">
                    <div className="flex items-baseline gap-4">
                      <span className="font-mono text-[10px] text-mute">0{index + 1}</span>
                      <h2 className="text-xl font-medium tracking-[-0.025em]">{section.heading}</h2>
                    </div>
                    <div className="mt-4 space-y-4">
                      {section.paragraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex} className="text-[15px] leading-7 text-mute">{paragraph}</p>)}
                      {section.bullets ? <ul className="list-disc space-y-2 pl-5 text-[15px] leading-7 text-mute">{section.bullets.map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul> : null}
                      {section.links ? <div className="flex flex-wrap gap-x-6 gap-y-3 pt-1">{section.links.map((link) => <a key={link.href} href={link.href} target={link.href.startsWith("http") ? "_blank" : undefined} rel={link.href.startsWith("http") ? "noopener noreferrer" : undefined} className="inline-flex items-center gap-1.5 text-sm text-paper underline decoration-white/20 underline-offset-4 transition-colors duration-[400ms] hover:decoration-white/70">{link.label}<ArrowUpRight size={13} /></a>)}</div> : null}
                    </div>
                  </section>
                </Reveal>
              ))}
            </div>
            <Reveal>
              <div className="mt-14 flex items-start gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.015] p-6">
                <FileText size={20} strokeWidth={1.5} className="mt-1 shrink-0 text-mute" />
                <div>
                  <h2 className="text-sm font-medium">Details you can inspect.</h2>
                  <p className="mt-2 text-sm leading-6 text-mute">For release-specific behavior and license notices, consult the desktop project and the version you install.</p>
                  <a href={SITE.github} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-2 text-sm text-paper underline decoration-white/20 underline-offset-4">View the project on GitHub <ArrowUpRight size={14} /></a>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </div>
  );
}
