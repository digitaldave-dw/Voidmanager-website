import { describe, it, expect, vi } from 'vitest';
import { ApiRepository } from './ApiRepository';

const projects = [
  { id: 7, name: 'Alpha', company: 'Acme', voidCountByStatus: {} },
  { id: 9, name: 'Beta', company: null, voidCountByStatus: {} },
];

const apiVoid = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  externalId: `ext-${id}`,
  type: 'rectangle',
  status: 'open for review',
  assignedTo: 'a@example.com',
  story: { name: 'Level 1', elevationMm: 3600 },
  host: 'Wall A',
  sizeMm: { diameter: null, width: 500, height: 400 },
  thicknessMm: 200,
  location: { x: 1, y: 2, z: 3 },
  direction: null,
  sequenceName: null,
  isClosed: false,
  building: 'B1',
  mergedIntoId: null,
  intersections: [],
  ...extra,
});

function fakeFetch(routes: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace('http://api.test', '');
    if (!(path in routes)) {
      return new Response(JSON.stringify({ title: 'Not Found', detail: `No route ${path}` }), { status: 404 });
    }
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  });
}

describe('ApiRepository', () => {
  it('lists projects as id + name', async () => {
    const repo = new ApiRepository('http://api.test/', fakeFetch({ '/api/projects': projects }));
    expect(await repo.listProjects()).toEqual([
      { id: 7, name: 'Alpha' },
      { id: 9, name: 'Beta' },
    ]);
  });

  it('maps API voids to VoidRow and filters by project name', async () => {
    const fetchFn = fakeFetch({
      '/api/projects': projects,
      '/api/projects/7/voids?includeClosed=true': [apiVoid(11)],
    });
    const repo = new ApiRepository('http://api.test', fetchFn);

    const rows = await repo.listVoids({ projectName: 'Alpha', includeClosed: true });

    expect(rows).toEqual([
      {
        id: 11,
        externalId: 'ext-11',
        type: 'rectangle',
        status: 'open for review',
        assignedTo: 'a@example.com',
        story: { name: 'Level 1', elevation: 3600 },
        host: 'Wall A',
        sizeMm: { width: 500, height: 400 },
        thicknessMm: 200,
        location: { x: 1, y: 2, z: 3 },
        direction: null,
        sequenceName: null,
        isClosed: false,
      },
    ]);
  });

  it('fetches voids of all projects when no project is given', async () => {
    const repo = new ApiRepository(
      'http://api.test',
      fakeFetch({
        '/api/projects': projects,
        '/api/projects/7/voids?includeClosed=false': [apiVoid(11)],
        '/api/projects/9/voids?includeClosed=false': [
          apiVoid(21, { type: 'circle', sizeMm: { diameter: 160, width: null, height: null } }),
        ],
      }),
    );

    const rows = await repo.listVoids();

    expect(rows.map((r) => r.id)).toEqual([11, 21]);
    expect(rows[1].sizeMm).toEqual({ diameter: 160 });
  });

  it('fails loudly on an unknown status or an API error', async () => {
    const bad = new ApiRepository(
      'http://api.test',
      fakeFetch({ '/api/projects': projects, '/api/projects/7/voids?includeClosed=false': [apiVoid(11, { status: 'Open' })] }),
    );
    await expect(bad.listVoids({ projectName: 'Alpha' })).rejects.toThrow(/unknown status "Open"/);

    const missing = new ApiRepository('http://api.test', fakeFetch({ '/api/projects': projects }));
    await expect(missing.listVoids({ projectName: 'Beta' })).rejects.toThrow(/API 404.*No route/);
    await expect(missing.listVoids({ projectName: 'Gamma' })).rejects.toThrow(/Unknown project "Gamma"/);
  });
});
