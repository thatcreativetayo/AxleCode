import type { Metadata } from "next";
import { ArrowUpRight, Code2, GitPullRequest, MessageSquare, Scale } from "lucide-react";
import { PageHero } from "@/components/site/page-hero";
import { Eyebrow, Section, SectionHead } from "@/components/site/section";
import { CTASection } from "@/components/site/cta-section";
import { Reveal, RevealGroup, RevealItem } from "@/components/fx/reveal";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NexiaLogo } from "@/components/site/nexia";
import { PRINCIPLES, REPOSITORY_URL } from "@/lib/product-content";

export const metadata: Metadata = { title: "Company", description: "The ideas behind Axle: capable AI development, freedom to choose your tools, and a workspace built in the open." };

function FreedomGraphic() {
  return <div className="relative flex min-h-[350px] items-center justify-center overflow-hidden rounded-[20px] border border-white/10 bg-[#101010] p-8" aria-label="Axle connects your code, tools, and choice">
    <svg viewBox="0 0 460 320" className="h-auto w-full max-w-md" role="img" aria-label="Three connected paths meeting in one workspace">
      <defs><pattern id="company-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="white" opacity=".14"/></pattern></defs>
      <rect width="460" height="320" fill="url(#company-grid)"/>
      <g fill="none" stroke="white" strokeOpacity=".12"><ellipse cx="230" cy="160" rx="160" ry="66" transform="rotate(-38 230 160)"/><ellipse cx="230" cy="160" rx="160" ry="66" transform="rotate(38 230 160)"/><ellipse cx="230" cy="160" rx="160" ry="66" transform="rotate(90 230 160)"/></g>
      <circle cx="230" cy="160" r="41" fill="#161616" stroke="white" strokeOpacity=".25"/>
      <path d="M215 176l15-32 15 32M220 167h20M228 146l5-10" fill="none" stroke="white" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"/>
      <g fill="#101010" stroke="white" strokeOpacity=".25"><circle cx="104" cy="78" r="6"/><circle cx="356" cy="78" r="6"/><circle cx="230" cy="309" r="6"/></g>
      <g fill="#aaa" fontSize="11" fontFamily="monospace" textAnchor="middle"><text x="104" y="58">YOUR CODE</text><text x="356" y="58">YOUR TOOLS</text><text x="230" y="286">YOUR CHOICE</text></g>
    </svg>
  </div>;
}

export default function CompanyPage() {
  return <>
    <PageHero eyebrow="The idea behind Axle" title={<>Better tools.<br/><span className="text-mute">More room to build.</span></>} copy="We believe the future of development should give builders more freedom. To choose their models, own their workflow, and spend more time on the work that matters."/>
    <Section id="about" className="scroll-mt-28 !pt-4">
      <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-24">
        <Reveal><div className="space-y-6 text-[15px] leading-8 text-mute"><p className="text-xl leading-8 tracking-tight text-paper">Powerful assistance should feel like an extension of your workspace.</p><p>Axle brings AI development to your computer. It works with your files, your terminal, and the model accounts you choose. The aim is simple: make it easier to get from an idea to code you understand.</p><p>That starts with a few practical decisions. Keep the work visible. Give people control over sensitive actions. Use ordinary files. Make the source available.</p><p>We are building a tool for people who care about what they make, and how they make it.</p></div><a href={REPOSITORY_URL} className="mt-8 inline-flex items-center gap-2 text-sm transition-colors duration-[400ms] ease-premium hover:text-mute">See what we are building <ArrowUpRight size={15}/></a></Reveal>
        <Reveal delay={.07}><FreedomGraphic/></Reveal>
      </div>
    </Section>
    <Section id="principles" divider className="scroll-mt-28">
      <SectionHead eyebrow="Our principles" title={<>A few things<br/><span className="text-mute">worth building around.</span></>}/>
      <RevealGroup className="mt-14 grid gap-4 sm:grid-cols-2">{PRINCIPLES.map(principle=><RevealItem key={principle.number}><Card className="flex h-full flex-col !rounded-[20px] !bg-[#101010] p-7 sm:p-9"><span className="font-mono text-[10px] text-mute">{principle.number}</span><h3 className="mt-7 text-xl font-medium tracking-[-.025em]">{principle.title}</h3><p className="mt-4 max-w-lg text-[13px] leading-7 text-mute">{principle.copy}</p></Card></RevealItem>)}</RevealGroup>
    </Section>
    <Section divider>
      <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-24"><SectionHead eyebrow="Open by design" title="A project you can be part of." copy="Good tools get better when people can look inside them. Explore the code, tell us what is getting in your way, or contribute a change."/>
        <div className="space-y-3">{[{icon:Code2,title:"Read the source",copy:"Understand how the workspace is built.",href:REPOSITORY_URL},{icon:GitPullRequest,title:"Make a contribution",copy:"Help with a fix, a feature, or the documentation.",href:REPOSITORY_URL+"/issues"},{icon:Scale,title:"Build on it",copy:"Axle's code is available under the MIT license.",href:REPOSITORY_URL+"/blob/main/axle-desktop/source/LICENSE"}].map(({icon:Icon,title,copy,href})=><a key={title} href={href} className="hairline ease-premium group flex items-center gap-4 rounded-2xl bg-[#101010] p-5 transition-colors duration-[400ms] hover:bg-[#161616]"><Icon size={20} strokeWidth={1.5} className="shrink-0 text-mute"/><div><h3 className="text-[13px]">{title}</h3><p className="mt-1 text-[11px] leading-6 text-mute">{copy}</p></div><ArrowUpRight size={15} className="ml-auto shrink-0 text-mute"/></a>)}</div>
      </div>
    </Section>
    <Section id="careers" divider className="scroll-mt-28">
      <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-24"><SectionHead eyebrow="Work with us" title={<>Care about the craft?<br/><span className="text-mute">Let us know.</span></>} copy="If you are interested in helping shape Axle, start a conversation through the project. Share what you have built, what you care about, and where you think you could help."/><div className="flex flex-col items-start justify-center gap-4"><Button href={REPOSITORY_URL+"/issues/new"} variant="secondary"><MessageSquare size={16}/>Start a conversation <ArrowUpRight size={15}/></Button><p className="max-w-sm text-xs leading-6 text-mute">For work, contribution, and collaboration enquiries. GitHub issues are public, so keep private details out of your message.</p></div></div>
    </Section>
    <Section id="nexia" divider className="scroll-mt-28">
      <Reveal>
        <div className="flex flex-col items-center gap-8 text-center">
          <Eyebrow>The company behind Axle</Eyebrow>
          <NexiaLogo className="text-[48px] sm:text-[68px] lg:text-[84px]"/>
          <p className="max-w-2xl text-[15.5px] leading-8 text-mute">Axle is designed, built, and maintained by Nexia. It is the same team, the same standard, and the same bias toward tools that stay out of your way.</p>
        </div>
      </Reveal>
    </Section>
    <Section id="contact" divider className="scroll-mt-28">
      <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between"><div><span className="font-mono text-[10px] uppercase tracking-[.12em] text-mute">Get in touch</span><h2 className="mt-4 text-3xl font-medium tracking-[-.04em]">The conversation is open.</h2><p className="mt-3 max-w-lg text-[13px] leading-7 text-mute">Questions, feedback, or a bug worth fixing. Find the project on GitHub and help make the next version better.</p></div><Button href={REPOSITORY_URL} variant="secondary"><Code2 size={16}/>Axle on GitHub <ArrowUpRight size={15}/></Button></div>
    </Section>
    <CTASection title="Build something your way." copy="Your code, your models, your next idea. Bring them together in Axle."/>
  </>;
}

