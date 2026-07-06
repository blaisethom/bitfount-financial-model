import type { ScenarioStore } from './scenarios';
import type { FormulaOverrides } from './formula';

export interface SavedModel {
  id: string;
  name: string;
  savedAt: string; // ISO datetime string
  scenarioStore: ScenarioStore;
  formulaOverrides: FormulaOverrides;
}

const STORAGE_KEY = 'bitfount-model.savedModels.v1';

export function loadSavedModels(): SavedModel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as SavedModel[];
  } catch {
    return [];
  }
}

export function persistSavedModels(models: SavedModel[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(models));
  } catch {
    // localStorage unavailable — work in-session only
  }
}
