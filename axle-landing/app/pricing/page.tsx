import type { Metadata } from "next";
import { PageHero } from "@/components/site/page-hero";
import { PricingBody } from "@/components/site/pricing-body";
import { CTASection } from "@/components/site/cta-section";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Start free with your own model keys, then upgrade to Pro, Pro+, or Ultra in the app for cloud jobs, monthly credits, and higher limits.",
};

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="A little less friction"
        title={
          <>
            Start with an idea.
            <br />
            <span className="text-mute">The workspace is on us.</span>
          </>
        }
        copy="Download Axle for free. Bring your own model keys, point it at any OpenAI-compatible endpoint, or keep inference on your own machine. Paid plans add cloud runs, more credits, and higher limits."
      />
      <PricingBody />
      <CTASection
        title="Your next project starts here."
        copy="Get the free desktop app. Connect a model. Make something that matters to you."
      />
    </>
  );
}
