// lib/data.ts
// Typed persistence for projects + work items. These functions are the ONLY place
// the app reads/writes the database. They return the same shapes the UI already
// uses (Project / WorkItem), so wiring them in is a drop-in swap for the SEED_*
// constants. Row-Level Security (see supabase-schema.sql) guarantees a user can
// only ever touch their own rows, so we never filter by user_id here manually.

import { supabase } from './supabase';

// These mirror the interfaces in AIPlayground.tsx. Kept in sync intentionally.
export interface Project {
  id: string;
  name: string;
  description?: string;
  color: string;
  pinned: boolean;
}
export type ItemType = 'project' | 'conversation' | 'file';
export interface WorkItem {
  id: string;
  title: string;
  type: ItemType;
  project: string | null;  // project NAME for display (null = ungrouped)
  modified: number;        // epoch ms
}

// ---------- PROJECTS ----------

export async function loadProjects(): Promise<Project[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('projects')
    .select('id,name,description,color,pinned')
    .order('created_at', { ascending: true });
  if (error || !data) return [];
  const rows = data as unknown as Array<{ id: string; name: string; description: string | null; color: string; pinned: boolean }>;
  return rows.map(r => ({
    id: r.id, name: r.name, description: r.description ?? undefined,
    color: r.color, pinned: r.pinned,
  }));
}

export async function createProject(
  userId: string, name: string, description: string, color: string,
): Promise<Project | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('projects')
    .insert({ user_id: userId, name, description: description || null, color, pinned: false })
    .select('id,name,description,color,pinned')
    .single();
  if (error || !data) return null;
  const d = data as unknown as { id: string; name: string; description: string | null; color: string; pinned: boolean };
  return { id: d.id, name: d.name, description: d.description ?? undefined, color: d.color, pinned: d.pinned };
}

export async function updateProject(
  id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'color' | 'pinned'>>,
): Promise<boolean> {
  if (!supabase) return false;
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.description !== undefined) row.description = patch.description || null;
  if (patch.color !== undefined) row.color = patch.color;
  if (patch.pinned !== undefined) row.pinned = patch.pinned;
  const { error } = await supabase.from('projects').update(row).eq('id', id);
  return !error;
}

export async function deleteProject(id: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from('projects').delete().eq('id', id);
  return !error;
}

// ---------- WORK ITEMS ----------

export async function loadItems(): Promise<WorkItem[]> {
  if (!supabase) return [];
  // Join project name for display; project_id null => ungrouped.
  const { data, error } = await supabase
    .from('work_items')
    .select('id,title,type,modified,projects(name)')
    .order('modified', { ascending: false });
  if (error || !data) return [];
  const rows = data as unknown as Array<{ id: string; title: string; type: ItemType; modified: string; projects: { name: string } | null }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    project: r.projects?.name ?? null,
    modified: new Date(r.modified).getTime(),
  }));
}

// Move an item into a project (by project id) or to ungrouped (null).
export async function setItemProject(itemId: string, projectId: string | null): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase
    .from('work_items')
    .update({ project_id: projectId, modified: new Date().toISOString() })
    .eq('id', itemId);
  return !error;
}
