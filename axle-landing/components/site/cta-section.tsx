import {ArrowUpRight} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Magnetic} from "@/components/fx/magnetic";
import {Reveal} from "@/components/fx/reveal";
import {LogoMark} from "./logo";
export function CTASection({title="Good ideas deserve to get built.",copy="Start with your codebase. Bring your favorite model. Make something that’s yours."}:{title?:string;copy?:string}){
 return <section className="final-cta" id="get-axle"><div className="cta-ambient" aria-hidden="true"/><div className="site-container relative"><Reveal><LogoMark className="mx-auto mb-8 h-10 w-9"/><p className="mono-label mb-5">Less between you and your next idea</p><h2>{title}</h2><p className="cta-copy">{copy}</p><div className="cta-buttons"><Magnetic><Button href="/download"><LogoMark className="cta-mark"/>Download Axle</Button></Magnetic><Button href="/docs" variant="secondary">Read the docs<ArrowUpRight size={18}/></Button></div><p className="cta-platforms">Also available for Windows and Linux.</p></Reveal></div></section>;
}
