import * as Ariakit from "@ariakit/react";
import {
  CalendarIcon,
  ClockIcon,
  FingerPrintIcon,
  RectangleStackIcon,
  Squares2X2Icon,
  TagIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { Form, useFetcher } from "@remix-run/react";
import { IconRotateClockwise2, IconToggleLeft } from "@tabler/icons-react";
import { MachinePresetName } from "@trigger.dev/core/v3";
import type { BulkActionType, TaskRunStatus, TaskTriggerSource } from "@trigger.dev/database";
import { ListFilterIcon } from "lucide-react";
import { matchSorter } from "match-sorter";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { ListCheckedIcon } from "~/assets/icons/ListCheckedIcon";
import { MachineDefaultIcon } from "~/assets/icons/MachineIcon";
import { StatusIcon } from "~/assets/icons/StatusIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import {
  formatMachinePresetName,
  MachineLabelCombo,
  machines,
} from "~/components/MachineLabelCombo";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Badge } from "~/components/primitives/Badge";
import { DateTime } from "~/components/primitives/DateTime";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  ComboBox,
  SelectButtonItem,
  SelectItem,
  SelectList,
  SelectPopover,
  SelectProvider,
  SelectTrigger,
  shortcutFromIndex,
} from "~/components/primitives/Select";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { useDebounceEffect } from "~/hooks/useDebounce";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import { type loader as queuesLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues";
import { type loader as versionsLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.versions";
import { type loader as tagsLoader } from "~/routes/resources.projects.$projectParam.runs.tags";
import { Button } from "../../primitives/Buttons";
import { BulkActionTypeCombo } from "./BulkAction";
import { appliedSummary, FilterMenuProvider, TimeFilter } from "./SharedFilters";
import { AIFilterInput } from "./AIFilterInput";
import {
  allTaskRunStatuses,
  descriptionForTaskRunStatus,
  filterableTaskRunStatuses,
  runStatusTitle,
  TaskRunStatusCombo,
} from "./TaskRunStatus";
import { TaskTriggerSourceIcon } from "./TaskTriggerSource";

export const RunStatus = z.enum(allTaskRunStatuses);

const StringOrStringArray = z.preprocess((value) => {
  if (typeof value === "string") {
    if (value.length > 0) {
      return [value];
    }

    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string" && v.length > 0);
  }

  return undefined;
}, z.string().array().optional());

export const MachinePresetOrMachinePresetArray = z.preprocess((value) => {
  if (typeof value === "string") {
    if (value.length > 0) {
      const parsed = MachinePresetName.safeParse(value);
      return parsed.success ? [parsed.data] : undefined;
    }

    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === "string" && v.length > 0)
      .map((v) => MachinePresetName.safeParse(v))
      .filter((result) => result.success)
      .map((result) => result.data);
  }

  return undefined;
}, MachinePresetName.array().optional());

export const TaskRunListSearchFilters = z.object({
  cursor: z.string().optional().describe("Cursor for pagination - used internally for navigation"),
  direction: z
    .enum(["forward", "backward"])
    .optional()
    .describe("Pagination direction - forward or backward. Used internally for navigation"),
  environments: StringOrStringArray.describe(
    "Environment names to filter by (DEVELOPMENT, STAGING, PREVIEW, PRODUCTION)"
  ),
  tasks: StringOrStringArray.describe(
    "Task identifiers to filter by (these are user-defined names)"
  ),
  versions: StringOrStringArray.describe(
    "Version identifiers to filter by (these are in this format 20250718.1). Needs to be looked up."
  ),
  statuses: z
    .preprocess((value) => {
      if (typeof value === "string") {
        if (value.length > 0) {
          return [value];
        }

        return undefined;
      }

      if (Array.isArray(value)) {
        return value.filter((v) => typeof v === "string" && v.length > 0);
      }

      return undefined;
    }, RunStatus.array().optional())
    .describe(`Run statuses to filter by (${filterableTaskRunStatuses.join(", ")})`),
  tags: StringOrStringArray.describe("Tag names to filter by (these are user-defined names)"),
  bulkId: z
    .string()
    .optional()
    .describe("Bulk action ID to filter by - shows runs from a specific bulk operation"),
  period: z
    .preprocess((value) => (value === "all" ? undefined : value), z.string().optional())
    .describe("Time period string (e.g., '1h', '7d', '30d', '1y') for relative time filtering"),
  from: z.coerce
    .number()
    .optional()
    .describe("Unix timestamp for start of time range - absolute time filtering"),
  to: z.coerce
    .number()
    .optional()
    .describe("Unix timestamp for end of time range - absolute time filtering"),
  rootOnly: z.coerce
    .boolean()
    .optional()
    .describe("Show only root runs (not child runs) - set to true to exclude sub-runs"),
  batchId: z
    .string()
    .optional()
    .describe(
      "Batch ID to filter by - shows runs from a specific batch operation. They start with batch_"
    ),
  runId: StringOrStringArray.describe("Specific run IDs to filter by. They start with run_"),
  scheduleId: z
    .string()
    .optional()
    .describe(
      "Schedule ID to filter by - shows runs from a specific schedule. They start with sched_"
    ),
  queues: StringOrStringArray.describe("Queue names to filter by (these are user-defined names)"),
  machines: MachinePresetOrMachinePresetArray.describe(
    `Machine presets to filter by (${machines.join(", ")})`
  ),
});

export type TaskRunListSearchFilters = z.infer<typeof TaskRunListSearchFilters>;
export type TaskRunListSearchFilterKey = keyof TaskRunListSearchFilters;

export function filterTitle(filterKey: string) {
  switch (filterKey) {
    case "cursor":
      return "Cursor";
    case "direction":
      return "Direction";
    case "statuses":
      return "Status";
    case "tasks":
      return "Tasks";
    case "tags":
      return "Tags";
    case "bulkId":
      return "Bulk action";
    case "period":
      return "Period";
    case "from":
      return "From";
    case "to":
      return "To";
    case "rootOnly":
      return "Root only";
    case "batchId":
      return "Batch ID";
    case "runId":
      return "Run ID";
    case "scheduleId":
      return "Schedule ID";
    case "queues":
      return "Queues";
    case "machines":
      return "Machine";
    case "versions":
      return "Version";
    default:
      return filterKey;
  }
}

export function filterIcon(filterKey: string): ReactNode | undefined {
  switch (filterKey) {
    case "cursor":
    case "direction":
      return undefined;
    case "statuses":
      return <StatusIcon className="size-4 border-text-bright" />;
    case "tasks":
      return <TaskIcon className="size-4" />;
    case "tags":
      return <TagIcon className="size-4" />;
    case "bulkId":
      return <ListCheckedIcon className="size-4" />;
    case "period":
      return <CalendarIcon className="size-4" />;
    case "from":
      return <CalendarIcon className="size-4" />;
    case "to":
      return <CalendarIcon className="size-4" />;
    case "rootOnly":
      return <IconToggleLeft className="size-4" />;
    case "batchId":
      return <Squares2X2Icon className="size-4" />;
    case "runId":
      return <FingerPrintIcon className="size-4" />;
    case "scheduleId":
      return <ClockIcon className="size-4" />;
    case "queues":
      return <RectangleStackIcon className="size-4" />;
    case "machines":
      return <MachineDefaultIcon className="size-4" />;
    case "versions":
      return <IconRotateClockwise2 className="size-4" />;
    default:
      return undefined;
  }
}

export function getRunFiltersFromSearchParams(
  searchParams: URLSearchParams
): TaskRunListSearchFilters {
  const params = {
    cursor: searchParams.get("cursor") ?? undefined,
    direction: searchParams.get("direction") ?? undefined,
    statuses:
      searchParams.getAll("statuses").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("statuses")
        : undefined,
    tasks:
      searchParams.getAll("tasks").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("tasks")
        : undefined,
    period: searchParams.get("period") ?? undefined,
    bulkId: searchParams.get("bulkId") ?? undefined,
    tags:
      searchParams.getAll("tags").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("tags").map((t) => decodeURIComponent(t))
        : undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    rootOnly: searchParams.has("rootOnly") ? searchParams.get("rootOnly") === "true" : undefined,
    runId:
      searchParams.getAll("runId").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("runId")
        : undefined,
    batchId: searchParams.get("batchId") ?? undefined,
    scheduleId: searchParams.get("scheduleId") ?? undefined,
    queues:
      searchParams.getAll("queues").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("queues")
        : undefined,
    machines:
      searchParams.getAll("machines").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("machines")
        : undefined,
    versions:
      searchParams.getAll("versions").filter((v) => v.length > 0).length > 0
        ? searchParams.getAll("versions")
        : undefined,
  };

  const parsed = TaskRunListSearchFilters.safeParse(params);

  if (!parsed.success) {
    return {};
  }

  return parsed.data;
}

type RunFiltersProps = {
  possibleTasks: { slug: string; triggerSource: TaskTriggerSource }[];
  bulkActions: {
    id: string;
    type: BulkActionType;
    createdAt: Date;
    name: string;
  }[];
  rootOnlyDefault: boolean;
  hasFilters: boolean;
};

export function RunsFilters(props: RunFiltersProps) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("statuses") ||
    searchParams.has("tasks") ||
    searchParams.has("bulkId") ||
    searchParams.has("tags") ||
    searchParams.has("batchId") ||
    searchParams.has("runId") ||
    searchParams.has("scheduleId") ||
    searchParams.has("queues") ||
    searchParams.has("machines") ||
    searchParams.has("versions");

  return (
    <div className="flex flex-row flex-wrap items-center gap-1">
      <FilterMenu {...props} />
      <AIFilterInput />
      <RootOnlyToggle defaultValue={props.rootOnlyDefault} />
      <TimeFilter />
      <AppliedFilters {...props} />
      {hasFilters && (
        <Form className="h-6">
          {searchParams.has("rootOnly") && (
            <input type="hidden" name="rootOnly" value={searchParams.get("rootOnly") as string} />
          )}
          <Button variant="secondary/small" LeadingIcon={XMarkIcon} tooltip="Clear all filters" />
        </Form>
      )}
    </div>
  );
}

const filterTypes = [
  {
    name: "statuses",
    title: "Status",
    icon: <StatusIcon className="size-4 border-text-bright" />,
  },
  { name: "tasks", title: "Tasks", icon: <TaskIcon className="size-4" /> },
  { name: "tags", title: "Tags", icon: <TagIcon className="size-4" /> },
  { name: "versions", title: "Versions", icon: <IconRotateClockwise2 className="size-4" /> },
  { name: "queues", title: "Queues", icon: <RectangleStackIcon className="size-4" /> },
  { name: "machines", title: "Machines", icon: <MachineDefaultIcon className="size-4" /> },
  { name: "run", title: "Run ID", icon: <FingerPrintIcon className="size-4" /> },
  { name: "batch", title: "Batch ID", icon: <Squares2X2Icon className="size-4" /> },
  { name: "schedule", title: "Schedule ID", icon: <ClockIcon className="size-4" /> },
  { name: "bulk", title: "Bulk action", icon: <ListCheckedIcon className="size-4" /> },
] as const;

type FilterType = (typeof filterTypes)[number]["name"];

const shortcut = { key: "f" };

function FilterMenu(props: RunFiltersProps) {
  const [filterType, setFilterType] = useState<FilterType | undefined>();

  const filterTrigger = (
    <SelectTrigger
      icon={
        <div className="flex size-4 items-center justify-center">
          <ListFilterIcon className="size-3.5" />
        </div>
      }
      variant={"secondary/small"}
      shortcut={shortcut}
      tooltipTitle={"Filter runs"}
      className="pr-0.5"
    >
      <></>
    </SelectTrigger>
  );

  return (
    <FilterMenuProvider onClose={() => setFilterType(undefined)}>
      {(search, setSearch) => (
        <Menu
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          trigger={filterTrigger}
          filterType={filterType}
          setFilterType={setFilterType}
          {...props}
        />
      )}
    </FilterMenuProvider>
  );
}

function AppliedFilters({ possibleTasks, bulkActions }: RunFiltersProps) {
  return (
    <>
      <AppliedStatusFilter />
      <AppliedTaskFilter possibleTasks={possibleTasks} />
      <AppliedTagsFilter />
      <AppliedVersionsFilter />
      <AppliedQueuesFilter />
      <AppliedMachinesFilter />
      <AppliedRunIdFilter />
      <AppliedBatchIdFilter />
      <AppliedScheduleIdFilter />
      <AppliedBulkActionsFilter bulkActions={bulkActions} />
    </>
  );
}

type MenuProps = {
  searchValue: string;
  clearSearchValue: () => void;
  trigger: React.ReactNode;
  filterType: FilterType | undefined;
  setFilterType: (filterType: FilterType | undefined) => void;
} & RunFiltersProps;

function Menu(props: MenuProps) {
  switch (props.filterType) {
    case undefined:
      return <MainMenu {...props} />;
    case "statuses":
      return <StatusDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tasks":
      return <TasksDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "bulk":
      return <BulkActionsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "tags":
      return <TagsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "queues":
      return <QueuesDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "machines":
      return <MachinesDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "run":
      return <RunIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "batch":
      return <BatchIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "schedule":
      return <ScheduleIdDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
    case "versions":
      return <VersionsDropdown onClose={() => props.setFilterType(undefined)} {...props} />;
  }
}

function MainMenu({ searchValue, trigger, clearSearchValue, setFilterType }: MenuProps) {
  const filtered = useMemo(() => {
    return filterTypes.filter((item) => {
      return item.title.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue]);

  return (
    <SelectProvider virtualFocus={true}>
      {trigger}
      <SelectPopover>
        <ComboBox placeholder={"Filter by..."} shortcut={shortcut} value={searchValue} />
        <SelectList>
          {filtered.map((type, index) => (
            <SelectButtonItem
              key={type.name}
              onClick={() => {
                clearSearchValue();
                setFilterType(type.name);
              }}
              icon={type.icon}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              {type.title}
            </SelectButtonItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const statuses = filterableTaskRunStatuses.map((status) => ({
  title: runStatusTitle(status),
  value: status,
}));

function StatusDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ statuses: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return statuses.filter((item) => item.title.toLowerCase().includes(searchValue.toLowerCase()));
  }, [searchValue]);

  return (
    <SelectProvider value={values("statuses")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by status..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item.value}
              value={item.value}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger className="group flex w-full flex-col py-0">
                    <TaskRunStatusCombo status={item.value} iconClassName="animate-none" />
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={50}>
                    <Paragraph variant="extra-small">
                      {descriptionForTaskRunStatus(item.value)}
                    </Paragraph>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedStatusFilter() {
  const { values, del } = useSearchParams();
  const statuses = values("statuses");

  if (statuses.length === 0 || statuses.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <StatusDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Status"
                icon={filterIcon("statuses")}
                value={appliedSummary(statuses.map((v) => runStatusTitle(v as TaskRunStatus)))}
                onRemove={() => del(["statuses", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function TasksDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  possibleTasks,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  possibleTasks: { slug: string; triggerSource: TaskTriggerSource }[];
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ tasks: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return possibleTasks.filter((item) => {
      return item.slug.toLowerCase().includes(searchValue.toLowerCase());
    });
  }, [searchValue, possibleTasks]);

  return (
    <SelectProvider value={values("tasks")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by task..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={`${item.triggerSource}-${item.slug}`}
              value={item.slug}
              icon={
                <TaskTriggerSourceIcon source={item.triggerSource} className="size-4 flex-none" />
              }
            >
              {item.slug}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedTaskFilter({ possibleTasks }: Pick<RunFiltersProps, "possibleTasks">) {
  const { values, del } = useSearchParams();

  if (values("tasks").length === 0 || values("tasks").every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TasksDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Task"
                icon={filterIcon("tasks")}
                value={appliedSummary(
                  values("tasks").map((v) => {
                    const task = possibleTasks.find((task) => task.slug === v);
                    return task ? task.slug : v;
                  })
                )}
                onRemove={() => del(["tasks", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          possibleTasks={possibleTasks}
        />
      )}
    </FilterMenuProvider>
  );
}

function BulkActionsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
  bulkActions,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
  bulkActions: RunFiltersProps["bulkActions"];
}) {
  const { value, replace } = useSearchParams();

  const handleChange = (value: string) => {
    clearSearchValue();
    replace({ bulkId: value, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    return bulkActions.filter((item) => {
      return (
        item.type.toLowerCase().includes(searchValue.toLowerCase()) ||
        item.createdAt.toISOString().includes(searchValue)
      );
    });
  }, [searchValue, bulkActions]);

  return (
    <SelectProvider value={value("bulkId")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(320px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by bulk action..."} value={searchValue} />
        <SelectList>
          <SelectItem value={""}>None</SelectItem>
          {filtered.map((item) => (
            <SelectItem key={item.id} value={item.id} className="[&>div]:h-fit">
              <div className="flex flex-col gap-1 py-1">
                <Paragraph variant="small/bright" className="truncate">
                  {item.name}
                </Paragraph>
                <div className="flex gap-3">
                  <BulkActionTypeCombo
                    type={item.type}
                    iconClassName="size-4"
                    labelClassName="text-text-dimmed"
                  />
                  <DateTime date={item.createdAt} />
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedBulkActionsFilter({ bulkActions }: Pick<RunFiltersProps, "bulkActions">) {
  const { value, del } = useSearchParams();

  const bulkId = value("bulkId");

  if (!bulkId) {
    return null;
  }

  const action = bulkActions.find((action) => action.id === bulkId);

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <BulkActionsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Bulk action"
                icon={filterIcon("bulkId")}
                value={bulkId}
                onRemove={() => del(["bulkId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
          bulkActions={bulkActions}
        />
      )}
    </FilterMenuProvider>
  );
}

function TagsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const project = useProject();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      tags: values.length > 0 ? values : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const tagValues = values("tags").filter((v) => v !== "");
  const selected = tagValues.length > 0 ? tagValues : undefined;

  const fetcher = useFetcher<typeof tagsLoader>();

  useEffect(() => {
    const searchParams = new URLSearchParams();
    if (searchValue) {
      searchParams.set("name", encodeURIComponent(searchValue));
    }
    fetcher.load(`/resources/projects/${project.slug}/runs/tags?${searchParams}`);
  }, [searchValue]);

  const filtered = useMemo(() => {
    let items: string[] = [];
    if (searchValue === "") {
      items = selected ?? [];
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(...fetcher.data.tags.map((t) => t.name));

    return matchSorter(Array.from(new Set(items)), searchValue);
  }, [searchValue, fetcher.data]);

  return (
    <SelectProvider value={selected ?? []} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox
          value={searchValue}
          render={(props) => (
            <div className="flex items-center justify-stretch">
              <input {...props} placeholder={"Filter by tags..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
        <SelectList>
          {filtered.length > 0
            ? filtered.map((tag, index) => (
                <SelectItem key={tag} value={tag}>
                  {tag}
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No tags found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedTagsFilter() {
  const { values, del } = useSearchParams();

  const tags = values("tags");

  if (tags.length === 0 || tags.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <TagsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Tags"
                icon={filterIcon("tags")}
                value={appliedSummary(values("tags"))}
                onRemove={() => del(["tags", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function QueuesDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      queues: values.length > 0 ? values : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const queueValues = values("queues").filter((v) => v !== "");
  const selected = queueValues.length > 0 ? queueValues : undefined;

  const fetcher = useFetcher<typeof queuesLoader>();

  useDebounceEffect(
    searchValue,
    (s) => {
      const searchParams = new URLSearchParams();
      searchParams.set("per_page", "25");
      if (searchValue) {
        searchParams.set("query", encodeURIComponent(s));
      }
      fetcher.load(
        `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
          environment.slug
        }/queues?${searchParams.toString()}`
      );
    },
    250
  );

  const filtered = useMemo(() => {
    let items: { name: string; type: "custom" | "task"; value: string }[] = [];

    for (const queueName of selected ?? []) {
      const queueItem = fetcher.data?.queues.find((q) => q.name === queueName);
      if (!queueItem) {
        if (queueName.startsWith("task/")) {
          items.push({
            name: queueName.replace("task/", ""),
            type: "task",
            value: queueName,
          });
        } else {
          items.push({
            name: queueName,
            type: "custom",
            value: queueName,
          });
        }
      }
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(
      ...fetcher.data.queues.map((q) => ({
        name: q.name,
        type: q.type,
        value: q.type === "task" ? `task/${q.name}` : q.name,
      }))
    );

    return matchSorter(Array.from(new Set(items)), searchValue, {
      keys: ["name"],
    });
  }, [searchValue, fetcher.data]);

  return (
    <SelectProvider value={selected ?? []} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox
          value={searchValue}
          render={(props) => (
            <div className="flex items-center justify-stretch">
              <input {...props} placeholder={"Filter by queues..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
        <SelectList>
          {filtered.length > 0
            ? filtered.map((queue) => (
                <SelectItem
                  key={queue.value}
                  value={queue.value}
                  icon={
                    queue.type === "task" ? (
                      <TaskIcon className="size-4 shrink-0 text-blue-500" />
                    ) : (
                      <RectangleStackIcon className="size-4 shrink-0 text-purple-500" />
                    )
                  }
                >
                  {queue.name}
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No queues found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedQueuesFilter() {
  const { values, del } = useSearchParams();

  const queues = values("queues");

  if (queues.length === 0 || queues.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <QueuesDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Queues"
                icon={filterIcon("queues")}
                value={appliedSummary(values("queues").map((v) => v.replace("task/", "")))}
                onRemove={() => del(["queues", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function MachinesDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({ machines: values, cursor: undefined, direction: undefined });
  };

  const filtered = useMemo(() => {
    if (searchValue === "") {
      return machines;
    }
    return matchSorter(machines, searchValue);
  }, [searchValue]);

  return (
    <SelectProvider value={values("machines")} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox placeholder={"Filter by machine..."} value={searchValue} />
        <SelectList>
          {filtered.map((item, index) => (
            <SelectItem
              key={item}
              value={item}
              shortcut={shortcutFromIndex(index, { shortcutsEnabled: true })}
            >
              <MachineLabelCombo preset={item} />
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedMachinesFilter() {
  const { values, del } = useSearchParams();
  const machines = values("machines");

  if (machines.length === 0 || machines.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <MachinesDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Machines"
                icon={filterIcon("machines")}
                value={appliedSummary(
                  machines.map((v) => {
                    const parsed = MachinePresetName.safeParse(v);
                    if (!parsed.success) {
                      return v;
                    }
                    return formatMachinePresetName(parsed.data);
                  })
                )}
                onRemove={() => del(["machines", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function VersionsDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { values, replace } = useSearchParams();

  const handleChange = (values: string[]) => {
    clearSearchValue();
    replace({
      versions: values.length > 0 ? values : undefined,
      cursor: undefined,
      direction: undefined,
    });
  };

  const versionValues = values("versions").filter((v) => v !== "");
  const selected = versionValues.length > 0 ? versionValues : undefined;

  const fetcher = useFetcher<typeof versionsLoader>();

  useDebounceEffect(
    searchValue,
    (s) => {
      const searchParams = new URLSearchParams();
      if (searchValue) {
        searchParams.set("query", encodeURIComponent(s));
      }
      fetcher.load(
        `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${
          environment.slug
        }/versions?${searchParams.toString()}`
      );
    },
    250
  );

  const filtered = useMemo(() => {
    let items: { version: string; isCurrent: boolean }[] = [];

    for (const version of selected ?? []) {
      const versionItem = fetcher.data?.versions.find((v) => v.version === version);
      if (!versionItem) {
        items.push({
          version,
          isCurrent: false,
        });
      }
    }

    if (fetcher.data === undefined) {
      return matchSorter(items, searchValue);
    }

    items.push(...fetcher.data.versions);

    if (searchValue === "") {
      return items;
    }

    return matchSorter(Array.from(new Set(items)), searchValue, {
      keys: ["version"],
    });
  }, [searchValue, fetcher.data]);

  return (
    <SelectProvider value={selected ?? []} setValue={handleChange} virtualFocus={true}>
      {trigger}
      <SelectPopover
        className="min-w-0 max-w-[min(240px,var(--popover-available-width))]"
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
      >
        <ComboBox
          value={searchValue}
          render={(props) => (
            <div className="flex items-center justify-stretch">
              <input {...props} placeholder={"Filter by versions..."} />
              {fetcher.state === "loading" && <Spinner color="muted" />}
            </div>
          )}
        />
        <SelectList>
          {filtered.length > 0
            ? filtered.map((version) => (
                <SelectItem key={version.version} value={version.version}>
                  <span className="flex items-center gap-2">
                    <span className="grow truncate">{version.version}</span>
                    {version.isCurrent ? <Badge variant="extra-small">Current</Badge> : null}
                  </span>
                </SelectItem>
              ))
            : null}
          {filtered.length === 0 && fetcher.state !== "loading" && (
            <SelectItem disabled>No versions found</SelectItem>
          )}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedVersionsFilter() {
  const { values, del } = useSearchParams();

  const versions = values("versions");

  if (versions.length === 0 || versions.every((v) => v === "")) {
    return null;
  }

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <VersionsDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Versions"
                icon={filterIcon("versions")}
                value={appliedSummary(values("versions"))}
                onRemove={() => del(["versions", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function RootOnlyToggle({ defaultValue }: { defaultValue: boolean }) {
  const { value, values, replace } = useSearchParams();
  const searchValue = value("rootOnly");
  const rootOnly = searchValue !== undefined ? searchValue === "true" : defaultValue;

  const batchId = value("batchId");
  const runId = value("runId");
  const scheduleId = value("scheduleId");
  const tasks = values("tasks");

  const disabled = !!batchId || !!runId || !!scheduleId || tasks.length > 0;

  return (
    <Switch
      disabled={disabled}
      variant="secondary/small"
      label="Root only"
      checked={disabled ? false : rootOnly}
      onCheckedChange={(checked) => {
        replace({
          rootOnly: checked ? "true" : "false",
        });
      }}
    />
  );
}

function RunIdDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const runIdValue = value("runId");

  const [runId, setRunId] = useState(runIdValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      runId: runId === "" ? undefined : runId?.toString(),
    });

    setOpen(false);
  }, [runId, replace]);

  let error: string | undefined = undefined;
  if (runId) {
    if (!runId.startsWith("run_")) {
      error = "Run IDs start with 'run_'";
    } else if (runId.length !== 25 && runId.length !== 29) {
      error = "Run IDs are 25/30 characters long";
    }
  }

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Run ID</Label>
            <Input
              placeholder="run_"
              value={runId ?? ""}
              onChange={(e) => setRunId(e.target.value)}
              variant="small"
              className="w-[27ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !runId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedRunIdFilter() {
  const { value, del } = useSearchParams();

  if (value("runId") === undefined) {
    return null;
  }

  const runId = value("runId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <RunIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Run ID"
                icon={filterIcon("runId")}
                value={runId}
                onRemove={() => del(["runId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function BatchIdDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const batchIdValue = value("batchId");

  const [batchId, setBatchId] = useState(batchIdValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      batchId: batchId === "" ? undefined : batchId?.toString(),
    });

    setOpen(false);
  }, [batchId, replace]);

  let error: string | undefined = undefined;
  if (batchId) {
    if (!batchId.startsWith("batch_")) {
      error = "Batch IDs start with 'batch_'";
    } else if (batchId.length !== 27 && batchId.length !== 31) {
      error = "Batch IDs are 27 or 31 characters long";
    }
  }

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Batch ID</Label>
            <Input
              placeholder="batch_"
              value={batchId ?? ""}
              onChange={(e) => setBatchId(e.target.value)}
              variant="small"
              className="w-[29ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !batchId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedBatchIdFilter() {
  const { value, del } = useSearchParams();

  if (value("batchId") === undefined) {
    return null;
  }

  const batchId = value("batchId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <BatchIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Batch ID"
                icon={filterIcon("batchId")}
                value={batchId}
                onRemove={() => del(["batchId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}

function ScheduleIdDropdown({
  trigger,
  clearSearchValue,
  searchValue,
  onClose,
}: {
  trigger: ReactNode;
  clearSearchValue: () => void;
  searchValue: string;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState<boolean | undefined>();
  const { value, replace } = useSearchParams();
  const scheduleIdValue = value("scheduleId");

  const [scheduleId, setScheduleId] = useState(scheduleIdValue);

  const apply = useCallback(() => {
    clearSearchValue();
    replace({
      cursor: undefined,
      direction: undefined,
      scheduleId: scheduleId === "" ? undefined : scheduleId?.toString(),
    });

    setOpen(false);
  }, [scheduleId, replace]);

  let error: string | undefined = undefined;
  if (scheduleId) {
    if (!scheduleId.startsWith("sched")) {
      error = "Schedule IDs start with 'sched_'";
    } else if (scheduleId.length !== 27) {
      error = "Schedule IDs are 27 characters long";
    }
  }

  return (
    <SelectProvider virtualFocus={true} open={open} setOpen={setOpen}>
      {trigger}
      <SelectPopover
        hideOnEnter={false}
        hideOnEscape={() => {
          if (onClose) {
            onClose();
            return false;
          }

          return true;
        }}
        className="max-w-[min(32ch,var(--popover-available-width))]"
      >
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-col gap-1">
            <Label>Schedule ID</Label>
            <Input
              placeholder="sched_"
              value={scheduleId ?? ""}
              onChange={(e) => setScheduleId(e.target.value)}
              variant="small"
              className="w-[29ch] font-mono"
              spellCheck={false}
            />
            {error ? <FormError>{error}</FormError> : null}
          </div>
          <div className="flex justify-between gap-1 border-t border-grid-dimmed pt-3">
            <Button variant="tertiary/small" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={error !== undefined || !scheduleId}
              variant="secondary/small"
              shortcut={{
                modifiers: ["mod"],
                key: "Enter",
                enabledOnInputElements: true,
              }}
              onClick={() => apply()}
            >
              Apply
            </Button>
          </div>
        </div>
      </SelectPopover>
    </SelectProvider>
  );
}

function AppliedScheduleIdFilter() {
  const { value, del } = useSearchParams();

  if (value("scheduleId") === undefined) {
    return null;
  }

  const scheduleId = value("scheduleId");

  return (
    <FilterMenuProvider>
      {(search, setSearch) => (
        <ScheduleIdDropdown
          trigger={
            <Ariakit.Select render={<div className="group cursor-pointer focus-custom" />}>
              <AppliedFilter
                label="Schedule ID"
                icon={filterIcon("scheduleId")}
                value={scheduleId}
                onRemove={() => del(["scheduleId", "cursor", "direction"])}
                variant="secondary/small"
              />
            </Ariakit.Select>
          }
          searchValue={search}
          clearSearchValue={() => setSearch("")}
        />
      )}
    </FilterMenuProvider>
  );
}
