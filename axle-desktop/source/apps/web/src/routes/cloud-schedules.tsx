import { createFileRoute, redirect } from "@tanstack/react-router";

// import { CloudSchedulesPage } from "../components/cloud/CloudSchedulesPage";

export const Route = createFileRoute("/cloud-schedules")({
  beforeLoad: () => {
    throw redirect({ to: "/schedules", replace: true });
  },
  // component: CloudSchedulesPage,
});
