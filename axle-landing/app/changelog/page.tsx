import type { Metadata } from "next";
import { ArrowUpRight, Check, GitBranch, Laptop, ShieldCheck, Smartphone } from "lucide-react";
import { PageHero } from "@/components/site/page-hero";
import { Section } from "@/components/site/section";
import { CTASection } from "@/components/site/cta-section";
import { Reveal } from "@/components/fx/reveal";
import { Button } from "@/components/ui/button";
import { PRODUCT_UPDATES, REPOSITORY_URL } from "@/lib/product-content";

export const metadata: Metadata = { title: "Changelog", description: "A running record of Axle development, with dated updates and links to the changes behind them." };

function RemoteAccessVisual() {
  return <div className="hairline mt-8 overflow-hidden rounded-[20px] bg-[#101010]">
    <div className="flex items-center justify-between border-b border-white/10 px-5 py-4"><span className="text-xs">Remote access</span><span className="flex items-center gap-1.5 font-mono text-[9px] text-mute"><ShieldCheck size={12}/>Your connection</span></div>
    <div className="flex items-center justify-center gap-5 px-6 py-10 sm:gap-8">
      <div className="text-center"><div className="hairline flex h-20 w-24 items-center justify-center rounded-xl bg-[#0a0a0a] sm:w-32"><Laptop size={34} strokeWidth={1}/></div><p className="mt-3 text-[10px] text-mute">Your computer</p></div>
      <div className="mb-7 flex flex-1 items-center gap-2 sm:max-w-32"><span className="h-1 w-1 rounded-full bg-white/60"/><span className="h-px flex-1 border-t border-dashed border-white/30"/><span className="h-1 w-1 rounded-full bg-white/60"/></div>
      <div className="text-center"><div className="hairline flex h-20 w-20 items-center justify-center rounded-xl bg-[#0a0a0a] sm:w-24"><Smartphone size={30} strokeWidth={1}/></div><p className="mt-3 text-[10px] text-mute">Another device</p></div>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4"><span className="text-[10px] text-mute">Local network or Tailscale</span><a href="/docs#remote-access" className="flex items-center gap-2 text-[10px] transition-colors duration-[400ms] ease-premium hover:text-mute">Connection guide <ArrowUpRight size={12}/></a></div>
  </div>;
}

export default function ChangelogPage() {
  return <>
    <PageHero eyebrow="Changelog" title={<>A little better.<br/><span className="text-mute">With every change.</span></>} copy="New capabilities, careful fixes, and the details that make the workspace feel right. Follow the work as it happens.">
      <Button href={REPOSITORY_URL + "/releases"} variant="secondary"><GitBranch size={16}/> Releases on GitHub <ArrowUpRight size={14}/></Button>
    </PageHero>
    <Section className="!pt-5">
      <div className="grid gap-12 lg:grid-cols-[220px_1fr] lg:gap-20">
        <aside className="hidden lg:block"><div className="sticky top-36"><p className="font-mono text-[10px] uppercase tracking-[.14em] text-mute">Latest development</p><nav aria-label="Updates" className="mt-6 space-y-5">{PRODUCT_UPDATES.map((entry,index)=><a key={entry.id} href={"#"+entry.id} className="ease-premium flex gap-3 text-xs leading-6 text-mute transition-colors duration-[400ms] hover:text-paper"><span className="font-mono text-[10px] text-mute-dim">0{index+1}</span>{entry.title}</a>)}</nav><a href={REPOSITORY_URL+"/commits"} className="mt-9 inline-flex items-center gap-2 text-xs">View all changes<ArrowUpRight size={13}/></a></div></aside>
        <div>{PRODUCT_UPDATES.map((entry,index)=><Reveal key={entry.id}><article id={entry.id} className="relative scroll-mt-32 border-t border-white/10 pb-16 pt-8 first:pt-0 first:border-0">
          <div className="mb-5 flex flex-wrap items-center gap-3"><time dateTime={entry.datetime} className="font-mono text-[10px] text-mute">{entry.date}</time><span className="hairline rounded-full px-2.5 py-1 font-mono text-[9px] text-mute">{entry.tag}</span>{index===0&&<span className="font-mono text-[9px] text-paper">LATEST</span>}</div>
          <h2 className="max-w-2xl text-[27px] font-medium leading-[1.2] tracking-[-.035em] sm:text-[34px]">{entry.title}</h2>
          <p className="mt-5 max-w-2xl text-sm leading-7 text-mute">{entry.summary}</p>
          {index===0&&<RemoteAccessVisual/>}
          <ul className="mt-7 space-y-3">{entry.items.map(item=><li key={item} className="flex items-start gap-3 text-[13px] leading-6 text-mute"><Check size={13} className="mt-1.5 shrink-0"/><span>{item}</span></li>)}</ul>
          <div className="mt-7 flex flex-wrap items-center gap-2"><span className="mr-1 text-[10px] text-mute-dim">Source changes</span>{entry.commits.map(commit=><a key={commit} href={REPOSITORY_URL+"/commit/"+commit} className="ease-premium rounded border border-white/10 px-2 py-1 font-mono text-[9px] text-mute transition-colors duration-[400ms] hover:border-white/25 hover:text-paper">{commit}</a>)}</div>
        </article></Reveal>)}
          <div className="hairline flex flex-col items-start justify-between gap-5 rounded-[20px] bg-[#101010] p-6 sm:flex-row sm:items-center"><div><h2 className="text-sm">The full story is in the source.</h2><p className="mt-2 text-xs leading-6 text-mute">Browse commits, report an issue, or help with the next update.</p></div><Button href={REPOSITORY_URL} variant="secondary" size="md"><GitBranch size={15}/> View source</Button></div>
        </div>
      </div>
    </Section>
    <CTASection title="See what is new in your workspace." copy="Get the latest desktop build and bring it into your next project."/>
  </>;
}

