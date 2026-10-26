import { Fragment } from "react";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/cn";

const COLUMNS = ["Free", "Pro", "Pro+", "Ultra"] as const;

type Cell = boolean | string;
type Row = { label: string; values: readonly [Cell, Cell, Cell, Cell] };

const GROUPS: readonly { group: string; rows: readonly Row[] }[] = [
  {
    group: "Workspace",
    rows: [
      {
        label: "Local projects, files, terminal, and Git",
        values: [true, true, true, true],
      },
      { label: "Bring your own model keys", values: [true, true, true, true] },
      { label: "Local model support", values: [true, true, true, true] },
      { label: "MCP server connections", values: [true, true, true, true] },
    ],
  },
  {
    group: "Cloud",
    rows: [
      { label: "Cloud jobs", values: [false, true, true, true] },
      {
        label: "Cloud schedules",
        values: [false, "Up to 50", "Up to 100", "Up to 200"],
      },
      { label: "Concurrent cloud jobs", values: ["—", "4", "6", "8"] },
      {
        label: "Axle credits",
        values: ["100 / day", "2,000 / mo", "4,000 / mo", "10,000 / mo"],
      },
    ],
  },
  {
    group: "Workflow",
    rows: [
      {
        label: "Model-assisted pull-request reviews",
        values: [false, true, true, true],
      },
    ],
  },
];

function CellValue({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <>
        <Check size={15} aria-hidden="true" className="mx-auto" />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <Minus size={15} aria-hidden="true" className="mx-auto text-white/30" />
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <>{value}</>;
}

export function ComparisonTable() {
  return (
    <div className="hairline overflow-hidden rounded-[20px] bg-[#101010]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <caption className="sr-only">
            Feature comparison across the Free, Pro, Pro+, and Ultra plans
          </caption>
          <thead>
            <tr className="border-b border-white/10">
              <th
                scope="col"
                className="px-6 py-6 text-sm font-normal text-mute"
              >
                Your workspace
              </th>
              {COLUMNS.map((label) => (
                <th
                  key={label}
                  scope="col"
                  className={cn(
                    "px-6 py-6 text-center text-sm font-medium",
                    label === "Pro" && "text-paper",
                  )}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map(({ group, rows }) => (
              <Fragment key={group}>
                <tr className="border-b border-white/10 bg-white/[0.02]">
                  <th
                    scope="colgroup"
                    colSpan={COLUMNS.length + 1}
                    className="px-6 py-3 text-left font-mono text-[10px] font-normal uppercase tracking-[0.18em] text-mute"
                  >
                    {group}
                  </th>
                </tr>
                {rows.map((row) => (
                  <tr
                    key={row.label}
                    className="border-b border-white/[0.07] last:border-b-0"
                  >
                    <th
                      scope="row"
                      className="px-6 py-5 text-[13px] font-normal text-mute"
                    >
                      {row.label}
                    </th>
                    {row.values.map((value, index) => (
                      <td
                        key={COLUMNS[index]}
                        className={cn(
                          "px-6 py-5 text-center text-xs",
                          value === false ? "text-white/30" : "text-paper",
                        )}
                      >
                        <CellValue value={value} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
