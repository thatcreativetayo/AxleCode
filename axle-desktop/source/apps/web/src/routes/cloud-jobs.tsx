import { createFileRoute, redirect } from "@tanstack/react-router";

// import { CloudJobsPage } from "../components/cloud/CloudJobsPage";

export const Route = createFileRoute("/cloud-jobs")({
  beforeLoad: () => {
    throw redirect({ to: "/schedules", replace: true });
  },
  // component: CloudJobsPage,
});
