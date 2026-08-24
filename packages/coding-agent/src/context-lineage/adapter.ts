import type { RepositoryEvidenceAdapter } from "./types";

/** Native bounded file capture is the only enabled adapter in the current-state MVP. */
export const NATIVE_CURRENT_STATE_ADAPTER: RepositoryEvidenceAdapter = {
	version: 1,
	adapterId: "native-current-state",
	adapterSchemaVersion: "v1",
	sourceKinds: ["workspace_file", "package_manifest", "configuration_file", "test_file", "maintained_decision"],
	sourceAuthority: "current",
	determinism: "deterministic",
	snapshotCoverage: "exact_with_overlay",
	evidenceClasses: ["current_structural", "current_workspace", "maintained_decision"],
	bitemporalProvenance: "not_supported",
	staleness: { state: "fresh" },
};
