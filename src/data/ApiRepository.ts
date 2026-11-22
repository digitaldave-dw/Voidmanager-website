/**
 * ApiRepository — VoidRepository over the Void Manager web API (digitaldave-dw/VoidManagerWeb).
 *
 * Calls:
 *   GET /api/projects                                   → ProjectSummary[] (+ company, counts)
 *   GET /api/projects/{id}/voids?includeClosed=<bool>   → VoidItem[]
 *
 * The API returns voids per project ID; the UI filters by project name, so names are mapped
 * to IDs from the last listProjects() call. Without a project, voids of all projects are fetched.
 * Sizes and coordinates arrive in Revit internal mm, the same units LocalDbRepository returns.
 *
 * READ-ONLY: updateVoidStatus is a seam, as in LocalDbRepository.
 */

import { isApprovalStatus, type ApprovalStatus } from './schema';
import type { ListVoidsOptions, ProjectSummary, VoidRepository, VoidRow } from './VoidRepository';

interface ApiPoint {
  x: number;
  y: number;
  z: number;
}

interface ApiProject {
  id: number;
  name: string;
  company: string | null;
}

interface ApiVoid {
  id: number;
  externalId: string | null;
  type: string;
  status: string;
  assignedTo: string | null;
  story: { name: string; elevationMm: number | null } | null;
  host: string | null;
  sizeMm: { diameter: number | null; width: number | null; height: number | null };
  thicknessMm: number | null;
  location: ApiPoint | null;
  direction: ApiPoint | null;
  sequenceName: string | null;
  isClosed: boolean;
}

export class ApiRepository implements VoidRepository {
  private projectIds = new Map<string, number>();
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const projects = await this.get<ApiProject[]>('/api/projects');
    this.projectIds = new Map(projects.map((p) => [p.name, p.id]));
    return projects.map((p) => ({ id: p.id, name: p.name }));
  }

  async listVoids(opts: ListVoidsOptions = {}): Promise<VoidRow[]> {
    if (this.projectIds.size === 0) await this.listProjects();

    let ids: number[];
    if (opts.projectName === undefined) {
      ids = [...this.projectIds.values()];
    } else {
      const id = this.projectIds.get(opts.projectName);
      if (id === undefined) throw new Error(`[ApiRepository] Unknown project "${opts.projectName}".`);
      ids = [id];
    }

    const query = `includeClosed=${opts.includeClosed ? 'true' : 'false'}`;
    const perProject = await Promise.all(
      ids.map((id) => this.get<ApiVoid[]>(`/api/projects/${id}/voids?${query}`)),
    );
    return perProject.flat().map(toVoidRow);
  }

  async updateVoidStatus(_voidId: number, _status: ApprovalStatus): Promise<void> {
    throw new Error('[ApiRepository] updateVoidStatus is not implemented: the API is read-only for now.');
  }

  private async get<T>(path: string): Promise<T> {
    const url = this.baseUrl + path;
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new Error(`Cannot reach the Void Manager API at ${this.baseUrl} (${String(e)}).`);
    }
    if (!response.ok) {
      // ProblemDetails: { title, detail, code }
      const problem = (await response.json().catch(() => null)) as { detail?: string; title?: string } | null;
      throw new Error(`API ${response.status} on ${path}: ${problem?.detail ?? problem?.title ?? response.statusText}`);
    }
    return (await response.json()) as T;
  }
}

function toVoidRow(v: ApiVoid): VoidRow {
  if (!isApprovalStatus(v.status)) {
    throw new Error(`[ApiRepository] Void ${v.id} has unknown status "${v.status}".`);
  }
  if (v.type !== 'circle' && v.type !== 'rectangle') {
    throw new Error(`[ApiRepository] Void ${v.id} has unknown type "${v.type}".`);
  }
  const size = v.sizeMm;
  return {
    id: v.id,
    externalId: v.externalId,
    type: v.type,
    status: v.status,
    assignedTo: v.assignedTo,
    story: v.story ? { name: v.story.name, elevation: v.story.elevationMm } : null,
    host: v.host,
    sizeMm: v.type === 'circle'
      ? { diameter: size.diameter ?? undefined }
      : { width: size.width ?? undefined, height: size.height ?? undefined },
    thicknessMm: v.thicknessMm,
    location: v.location,
    direction: v.direction,
    sequenceName: v.sequenceName,
    isClosed: v.isClosed,
  };
}
