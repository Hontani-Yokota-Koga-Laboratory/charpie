import type { Doc } from '../dsl/types';
import type { Issue } from './check';

export interface IssueOut {
  id: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
  nodes: string[];
  edges: string[];
  /** 1-based line of the first involved statement */
  line?: number;
  /** deck: where it was found (`page intro` / `layout base`) */
  view?: string;
}

export function issuesOut(a: { doc: Doc; issues: Issue[] }, src: string): IssueOut[] {
  const syntax: IssueOut[] = a.doc.diagnostics.map((d, i) => ({
    id: `syntax:${i}`,
    code: 'syntax',
    severity: d.severity === 'error' ? 'error' : 'warning',
    message: d.message,
    nodes: [],
    edges: [],
    line: src.slice(0, d.from).split('\n').length,
  }));
  return [
    ...syntax,
    ...a.issues.map((i) => {
      const n = i.nodes[0] ? a.doc.nodeMap.get(i.nodes[0]) : undefined;
      const e = i.edges[0] ? a.doc.edges.find((x) => x.key === i.edges[0]) : undefined;
      const def = i.code === 'edge-through' || i.code === 'label-overlap' ? (e ?? n) : (n ?? e);
      return { id: i.id, code: i.code, severity: i.severity, message: i.message, nodes: i.nodes, edges: i.edges, line: def ? def.line + 1 : undefined };
    }),
  ];
}

