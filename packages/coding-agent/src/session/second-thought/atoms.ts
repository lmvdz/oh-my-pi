import alternativePrompt from "./prompts/atom-alternative.md" with { type: "text" };
import checkPrompt from "./prompts/atom-check.md" with { type: "text" };
import recallPrompt from "./prompts/atom-recall.md" with { type: "text" };
import rehearsePrompt from "./prompts/atom-rehearse.md" with { type: "text" };
import combinedBranchPrompt from "./prompts/combined-branch.md" with { type: "text" };

export enum ReflectAtom {
	Check = "check",
	Rehearse = "rehearse",
	Recall = "recall",
	Alternative = "alternative",
}

export const ATOM_NAMES = [
	ReflectAtom.Check,
	ReflectAtom.Rehearse,
	ReflectAtom.Recall,
	ReflectAtom.Alternative,
] as const;

export const REFLECT_ATOMS = ATOM_NAMES;

export const ATOM_PROMPTS = {
	[ReflectAtom.Check]: checkPrompt,
	[ReflectAtom.Rehearse]: rehearsePrompt,
	[ReflectAtom.Recall]: recallPrompt,
	[ReflectAtom.Alternative]: alternativePrompt,
} as const satisfies Readonly<Record<ReflectAtom, string>>;

export const COMBINED_BRANCH_PROMPT = combinedBranchPrompt;
