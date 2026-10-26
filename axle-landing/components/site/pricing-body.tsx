import { Section, SectionHead } from "@/components/site/section";
import { PricingCards } from "@/components/site/pricing-card";
import { ComparisonTable } from "@/components/site/comparison";
import { Accordion } from "@/components/site/accordion";
import { Reveal } from "@/components/fx/reveal";
import { PRICING_FAQS } from "@/lib/catalog";

export function PricingBody() {
  return (
    <>
      <Section className="!pt-5">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-mute">
            Plans &amp; billing
          </p>
          <p className="text-xs text-mute">
            Start free. No Axle credit card required.
          </p>
        </div>
        <PricingCards />
        <p className="mt-7 max-w-3xl text-xs leading-6 text-mute">
          Free is available today. Pro, Pro+, and Ultra are available as
          monthly subscriptions in the app. Prices shown are monthly and are
          confirmed before checkout.
        </p>
      </Section>
      <Section divider>
        <SectionHead
          eyebrow="All the details"
          title="Know what you're getting."
          copy="The core workspace is free. Paid plans add cloud runs, monthly credits, and higher limits."
        />
        <Reveal className="mt-12">
          <ComparisonTable />
        </Reveal>
      </Section>
      <Section divider>
        <div className="grid gap-12 lg:grid-cols-[0.75fr_1.25fr] lg:gap-20">
          <SectionHead
            eyebrow="Good questions"
            title="A few things worth knowing."
            copy="A clear start, without the small print surprise."
          />
          <Reveal delay={0.08}>
            <Accordion items={PRICING_FAQS} />
          </Reveal>
        </div>
      </Section>
    </>
  );
}
