import { useResource } from "../data/useResource";
import { AsyncBoundary } from "../ui/AsyncBoundary";
import { DataTable, type DataTableColumn } from "../ui/DataTable";
import { Panel } from "../ui/Panel";

interface RoutingStats {
	total: number;
	cheapCount: number;
	capableCount: number;
	byRoute: Record<string, number>;
	recent: Array<{
		ts: number;
		route: string | null;
		tier: string | null;
		target: string | null;
		reason: string | null;
	}>;
}

type RoutingDecision = RoutingStats["recent"][number];

export interface RoutingRouteProps {
	active: boolean;
	refreshTrigger: number;
}

export function RoutingRoute({ active, refreshTrigger }: RoutingRouteProps) {
	const { data: stats, loading, error } = useResource<RoutingStats>(
		["routing", refreshTrigger],
		async signal => {
			const response = await fetch("/api/stats/routing", { signal });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} loading routing stats`);
			}
			return response.json() as Promise<RoutingStats>;
		},
		{ enabled: active, pollMs: 30_000 },
	);
	const columns: DataTableColumn<RoutingDecision>[] = [
		{ key: "time", header: "Time", render: row => new Date(row.ts).toLocaleTimeString() },
		{ key: "route", header: "Route" },
		{ key: "tier", header: "Tier" },
		{ key: "target", header: "Target" },
		{ key: "reason", header: "Reason" },
	];

	return (
		<div className="stats-route-container space-y-6">
			<AsyncBoundary loading={loading} error={error} data={stats}>
				{stats && (
					<>
						<div className="grid grid-cols-3 gap-4">
							<Panel title="Total Decisions" subtitle={`${stats.total} recorded`} />
							<Panel
								title="Cheap"
								subtitle={`${stats.cheapCount} (${stats.total > 0 ? ((stats.cheapCount / stats.total) * 100).toFixed(1) : "0"}%)`}
							/>
							<Panel
								title="Capable"
								subtitle={`${stats.capableCount} (${stats.total > 0 ? ((stats.capableCount / stats.total) * 100).toFixed(1) : "0"}%)`}
							/>
						</div>
						<Panel title="Recent Routing Decisions" subtitle="Last 50 decisions">
							<DataTable
								columns={columns}
								data={stats.recent}
								keyExtractor={row => `${row.ts}-${row.route ?? ""}-${row.target ?? ""}`}
							/>
						</Panel>
					</>
				)}
			</AsyncBoundary>
		</div>
	);
}
