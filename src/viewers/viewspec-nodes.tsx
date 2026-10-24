import React, { useState, useEffect, useContext, createContext } from "react";
import type {
  ViewNode,
  HeadingNode,
  MarkdownNode,
  CalloutNode,
  KeyValueNode,
  TableNode,
  ListNode,
  TreeNode,
  TreeEntry,
  CodeNode,
  DiffNode,
  ImageNode,
  ChartNode,
  SectionNode,
  ColumnsNode,
  FileRefNode,
} from "../../shared/viewspec.d.mts";
import { AgentMarkdown, sanitizeLabel } from "./agent-markdown";
import { highlight } from "./highlight";
import { runDiff, parseUnified, type Hunk } from "./viewspec-diff";

export function HeadingRenderer({ node }: { node: HeadingNode }): React.ReactElement {
  const level = node.level ?? 2;
  switch (level) {
    case 1:
      return <h2 className="vs-heading">{node.text}</h2>;
    case 2:
      return <h3 className="vs-heading">{node.text}</h3>;
    case 3:
      return <h4 className="vs-heading">{node.text}</h4>;
    case 4:
      return <h5 className="vs-heading">{node.text}</h5>;
    default:
      return <h2 className="vs-heading">{node.text}</h2>;
  }
}

export function MarkdownRenderer({ node }: { node: MarkdownNode }): React.ReactElement {
  return <AgentMarkdown text={node.text} className="vs-markdown" />;
}

export function CalloutRenderer({ node }: { node: CalloutNode }): React.ReactElement {
  return (
    <div className={`vs-callout tone-${node.tone}`}>
      {node.title && <div className="vs-callout-title">{node.title}</div>}
      <AgentMarkdown text={node.text} className="vs-callout-body" />
    </div>
  );
}

export function KeyValueRenderer({ node }: { node: KeyValueNode }): React.ReactElement {
  return (
    <dl className="vs-key-value">
      {node.items.map((item, i) => (
        <React.Fragment key={i}>
          <dt>{item.key}</dt>
          <dd>{item.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function TableRenderer({ node }: { node: TableNode }): React.ReactElement {
  const [visibleCount, setVisibleCount] = useState(500);
  const rows = node.rows || [];
  const visibleRows = rows.slice(0, visibleCount);
  const remaining = rows.length - visibleCount;

  return (
    <div className="vs-table-wrap">
      <table className="vs-table">
        <thead>
          <tr>
            {node.columns.map((col) => (
              <th
                key={col.key}
                className={col.align ? `align-${col.align}` : undefined}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row, rIdx) => (
            <tr key={rIdx}>
              {node.columns.map((col) => {
                const cellVal = row[col.key];
                const textVal =
                  cellVal === null || cellVal === undefined
                    ? ""
                    : String(cellVal);
                return (
                  <td
                    key={col.key}
                    className={col.align ? `align-${col.align}` : undefined}
                  >
                    {textVal}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {remaining > 0 && (
        <button
          type="button"
          className="vs-more-rows"
          onClick={() => setVisibleCount((c) => c + 500)}
        >
          Show 500 more rows ({remaining} left)
        </button>
      )}
    </div>
  );
}

export function ListRenderer({ node }: { node: ListNode }): React.ReactElement {
  const Tag = node.ordered ? "ol" : "ul";
  return (
    <Tag className="vs-list">
      {node.items.map((item, idx) => (
        <li key={idx}>
          {typeof item === "string" ? item : <ViewNodeRenderer node={item} />}
        </li>
      ))}
    </Tag>
  );
}

function TreeItem({
  entry,
  depth,
}: {
  entry: TreeEntry;
  depth: number;
}): React.ReactElement {
  const hasChildren = entry.children && entry.children.length > 0;
  return (
    <details className="vs-tree-entry" open={depth < 2}>
      <summary className="vs-tree-summary">
        <span className="vs-tree-label">{entry.label}</span>
        {entry.detail && (
          <span className="vs-tree-detail">{entry.detail}</span>
        )}
      </summary>
      {hasChildren && (
        <div className="vs-tree-children">
          {entry.children!.map((child, idx) => (
            <TreeItem key={idx} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </details>
  );
}

export function TreeRenderer({ node }: { node: TreeNode }): React.ReactElement {
  return (
    <div className="vs-tree">
      {node.nodes.map((entry, idx) => (
        <TreeItem key={idx} entry={entry} depth={0} />
      ))}
    </div>
  );
}

function isLineHighlighted(
  lineNum: number,
  ranges?: [number, number][]
): boolean {
  if (!ranges || ranges.length === 0) return false;
  for (const range of ranges) {
    if (!range) continue;
    const [start, end] = range;
    if (
      start !== undefined &&
      end !== undefined &&
      lineNum >= start &&
      lineNum <= end
    ) {
      return true;
    }
  }
  return false;
}

function splitHighlightedHtml(html: string): string[] {
  const lines = html.split("\n");
  const result: string[] = [];
  const openTags: string[] = [];
  const tagRegex = /<\/?span[^>]*>/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prefix = openTags.join("");
    const currentTags = [...openTags];
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(line)) !== null) {
      if (match[0].startsWith("</")) {
        currentTags.pop();
      } else {
        currentTags.push(match[0]);
      }
    }

    const suffix = currentTags.map(() => "</span>").join("");
    result.push(prefix + line + suffix);
    openTags.length = 0;
    openTags.push(...currentTags);
  }

  return result;
}

export function CodeRenderer({ node }: { node: CodeNode }): React.ReactElement {
  const highlightedHtml = highlight(node.text, node.language);
  const isHtml = highlightedHtml !== null;
  const lines = isHtml
    ? splitHighlightedHtml(highlightedHtml)
    : node.text.split("\n");

  return (
    <pre className="vs-code-pre">
      <code className="vs-code">
        {lines.map((lineContent, idx) => {
          const lineNum = idx + 1;
          const isHl = isLineHighlighted(lineNum, node.highlightLines);
          const className = `vs-code-line${isHl ? " vs-hl" : ""}`;
          if (isHtml) {
            return (
              <span
                key={idx}
                className={className}
                dangerouslySetInnerHTML={{ __html: lineContent || " " }}
              />
            );
          }
          return (
            <span key={idx} className={className}>
              {lineContent || " "}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

export function DiffRenderer({ node }: { node: DiffNode }): React.ReactElement {
  const [diffState, setDiffState] = useState<{
    kind: "loading" | "diff" | "too_big";
    hunks?: Hunk[];
  }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    if ("unified" in node) {
      try {
        const hunks = parseUnified(node.unified);
        setDiffState({ kind: "diff", hunks });
      } catch {
        setDiffState({ kind: "too_big" });
      }
    } else {
      runDiff(node.before, node.after, { timeoutMs: 2000 }).then((res) => {
        if (cancelled) return;
        if (res.kind === "diff") {
          setDiffState({ kind: "diff", hunks: res.hunks });
        } else {
          setDiffState({ kind: "too_big" });
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, [node]);

  if (diffState.kind === "loading") {
    return <div className="vs-diff-loading">Computing diff…</div>;
  }

  if (diffState.kind === "too_big") {
    return (
      <div className="vs-diff-too-big">
        <div className="vs-diff-too-big-note">Too large to compare here</div>
        {"before" in node && "after" in node && (
          <div className="vs-diff-panes">
            <div className="vs-diff-pane">
              <div className="vs-diff-pane-title">Before</div>
              <pre>{node.before}</pre>
            </div>
            <div className="vs-diff-pane">
              <div className="vs-diff-pane-title">After</div>
              <pre>{node.after}</pre>
            </div>
          </div>
        )}
      </div>
    );
  }

  const hunks = diffState.hunks || [];

  return (
    <div className="vs-diff">
      {node.title && <div className="vs-diff-title">{node.title}</div>}
      <div className="vs-diff-unified">
        {hunks.map((hunk, hIdx) => (
          <div key={hIdx} className="vs-diff-hunk">
            <div className="vs-diff-hunk-header">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},
              {hunk.newLines} @@
            </div>
            {hunk.lines.map((line, lIdx) => {
              const isAdd = line.startsWith("+");
              const isDel = line.startsWith("-");
              const cls = isAdd
                ? "vs-diff-line vs-diff-add diff-add"
                : isDel
                ? "vs-diff-line vs-diff-del diff-del"
                : "vs-diff-line vs-diff-ctx";
              return (
                <div key={lIdx} className={cls}>
                  {line}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

const CHART_PALETTE = [
  "#0F766E",
  "#2563EB",
  "#D97706",
  "#DC2626",
  "#7C3AED",
  "#DB2777",
  "#059669",
  "#4F46E5",
];

export function ChartRenderer({ node }: { node: ChartNode }): React.ReactElement {
  const { kind, x, series } = node;
  const ariaLabel = `${kind} chart: ${series.map((s) => s.name).join(", ")} over ${x.join(", ")}`;

  let maxVal = 0;
  let minVal = 0;
  for (const s of series) {
    for (const v of s.values) {
      if (v > maxVal) maxVal = v;
      if (v < minVal) minVal = v;
    }
  }
  if (maxVal === minVal) maxVal = minVal + 1;

  const width = 600;
  const height = 300;
  const padTop = 20;
  const padBottom = 40;
  const padLeft = 50;
  const padRight = 20;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const getY = (val: number) => {
    const pct = (val - minVal) / (maxVal - minVal);
    return padTop + plotH - pct * plotH;
  };

  const xCount = x.length;
  const groupWidth = xCount > 0 ? plotW / xCount : plotW;

  return (
    <div className="vs-chart-container">
      <div className="vs-chart-legend">
        {series.map((s, idx) => (
          <span key={s.name} className="vs-chart-legend-item">
            <span
              className="vs-chart-legend-dot"
              style={{
                backgroundColor: CHART_PALETTE[idx % CHART_PALETTE.length],
              }}
            />
            {s.name}
          </span>
        ))}
      </div>
      <svg
        className="vs-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
      >
        <line
          x1={padLeft}
          y1={padTop + plotH}
          x2={padLeft + plotW}
          y2={padTop + plotH}
          className="vs-chart-axis"
        />
        <line
          x1={padLeft}
          y1={padTop}
          x2={padLeft}
          y2={padTop + plotH}
          className="vs-chart-axis"
        />
        <text
          x={padLeft - 8}
          y={padTop + 10}
          textAnchor="end"
          className="vs-chart-tick"
        >
          {maxVal}
        </text>
        <text
          x={padLeft - 8}
          y={padTop + plotH}
          textAnchor="end"
          className="vs-chart-tick"
        >
          {minVal}
        </text>
        {x.map((xLabel, idx) => {
          const xPos = padLeft + idx * groupWidth + groupWidth / 2;
          return (
            <text
              key={idx}
              x={xPos}
              y={padTop + plotH + 20}
              textAnchor="middle"
              className="vs-chart-tick"
            >
              {xLabel}
            </text>
          );
        })}
        {kind === "bar"
          ? series.map((s, sIdx) => {
              const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
              const seriesCount = series.length;
              const barPad = 4;
              const totalBarSpace = groupWidth * 0.8;
              const barW = Math.max(
                2,
                (totalBarSpace - (seriesCount - 1) * barPad) / seriesCount
              );
              const startOffset =
                (groupWidth -
                  (barW * seriesCount + (seriesCount - 1) * barPad)) /
                2;

              return (
                <g key={s.name}>
                  {s.values.map((v, vIdx) => {
                    const barX =
                      padLeft +
                      vIdx * groupWidth +
                      startOffset +
                      sIdx * (barW + barPad);
                    const barY = getY(v);
                    const zeroY = getY(0);
                    const yPos = Math.min(barY, zeroY);
                    const barH = Math.max(1, Math.abs(zeroY - barY));
                    return (
                      <rect
                        key={vIdx}
                        x={barX}
                        y={yPos}
                        width={barW}
                        height={barH}
                        fill={color}
                        className="vs-chart-bar"
                      />
                    );
                  })}
                </g>
              );
            })
          : series.map((s, sIdx) => {
              const color = CHART_PALETTE[sIdx % CHART_PALETTE.length];
              const points = s.values.map((v, vIdx) => {
                const cx =
                  xCount > 1
                    ? padLeft + (vIdx / (xCount - 1)) * plotW
                    : padLeft + plotW / 2;
                const cy = getY(v);
                return { cx, cy };
              });
              const d = points
                .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.cx} ${p.cy}`)
                .join(" ");

              return (
                <g key={s.name}>
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    className="vs-chart-line"
                  />
                  {points.map((p, pIdx) => (
                    <circle
                      key={pIdx}
                      cx={p.cx}
                      cy={p.cy}
                      r="3"
                      fill={color}
                      className="vs-chart-dot"
                    />
                  ))}
                </g>
              );
            })}
      </svg>
    </div>
  );
}

export function SectionRenderer({ node }: { node: SectionNode }): React.ReactElement {
  return (
    <details className="vs-section" open={!node.collapsed}>
      {node.title && (
        <summary className="vs-section-title">{node.title}</summary>
      )}
      <div className="vs-section-content">
        {node.children.map((child, idx) => (
          <ViewNodeRenderer key={idx} node={child} />
        ))}
      </div>
    </details>
  );
}

export function ColumnsRenderer({ node }: { node: ColumnsNode }): React.ReactElement {
  const colCount = node.columns.length;
  return (
    <div
      className="vs-columns"
      style={{
        gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))`,
      }}
    >
      {node.columns.map((col, cIdx) => (
        <div key={cIdx} className="vs-column">
          {col.map((child, idx) => (
            <ViewNodeRenderer key={idx} node={child} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * What a surrounding viewer knows about the files an agent view points at. Without a provider (the
 * plain view viewer) images and fileRefs show the static "opens through UniView" placeholders. The
 * phone/web receipt viewer provides one that looks each reference up on the LAN root or among the
 * files the person picked.
 */
export type ViewReferenceState =
  | { status: "found"; open: () => void }
  | { status: "missing" }
  | { status: "unreadable" };

export interface ViewReferenceResolver {
  resolve(ref: { kind: "image" | "fileRef"; path: string; relPath?: string }): Promise<ViewReferenceState>;
}

export const ViewReferenceContext = createContext<ViewReferenceResolver | null>(null);

/** null: no resolver (static placeholders); "checking": lookup in flight. */
function useViewReference(
  kind: "image" | "fileRef",
  path: string,
  relPath: string | undefined
): ViewReferenceState | "checking" | null {
  const resolver = useContext(ViewReferenceContext);
  const [state, setState] = useState<ViewReferenceState | "checking">("checking");
  useEffect(() => {
    if (!resolver) return;
    let cancelled = false;
    setState("checking");
    resolver.resolve({ kind, path, relPath }).then(
      (r) => {
        if (!cancelled) setState(r);
      },
      () => {
        if (!cancelled) setState({ status: "unreadable" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [resolver, kind, path, relPath]);
  return resolver ? state : null;
}

export function ImageRenderer({ node }: { node: ImageNode }): React.ReactElement {
  const ref = useViewReference("image", node.path, node.relPath);
  if (ref === null) {
    return (
      <div className="vs-placeholder vs-image-placeholder">
        <div className="vs-placeholder-header">Image: {node.alt}</div>
        <div className="vs-placeholder-note">
          Images in agent views appear when an agent opens this view through
          UniView
        </div>
        {node.caption && (
          <div className="vs-placeholder-caption">{node.caption}</div>
        )}
      </div>
    );
  }
  const found = ref !== "checking" && ref.status === "found";
  return (
    <div
      className={
        found
          ? "vs-placeholder vs-image-placeholder"
          : "vs-placeholder vs-image-placeholder agent-image-placeholder"
      }
      data-placeholder={found ? undefined : "true"}
    >
      <div className="vs-placeholder-header">Image: {node.alt}</div>
      <div className="vs-placeholder-note">
        {ref === "checking"
          ? "Looking for this image on this device…"
          : found
            ? "This image is on this device, but showing images in views is not available on phone and web yet."
            : "image not available on this device"}
      </div>
      {node.caption && (
        <div className="vs-placeholder-caption">{node.caption}</div>
      )}
    </div>
  );
}

export function FileRefRenderer({ node }: { node: FileRefNode }): React.ReactElement {
  const ref = useViewReference("fileRef", node.path, node.relPath);
  const labelText = sanitizeLabel(node.label ?? node.path, 4096);
  if (ref === null) {
    return (
      <div className="vs-placeholder vs-fileref-placeholder">
        <span className="vs-fileref-text">{labelText}</span>
        <button type="button" disabled className="vs-fileref-btn">
          Open
        </button>
        <div className="vs-placeholder-note">
          Images in agent views appear when an agent opens this view through
          UniView
        </div>
      </div>
    );
  }
  const found = ref !== "checking" && ref.status === "found";
  return (
    <div className="vs-placeholder vs-fileref-placeholder">
      <span className="vs-fileref-text">{labelText}</span>
      {found ? (
        <button
          type="button"
          className="vs-fileref-btn agent-fileref"
          onClick={() => ref.open()}
        >
          Open
        </button>
      ) : (
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="vs-fileref-btn agent-fileref disabled"
          title="File not available on this device"
        >
          Open
        </button>
      )}
      {!found && ref !== "checking" && (
        <div className="vs-placeholder-note">File not available on this device</div>
      )}
    </div>
  );
}

export function ViewNodeRenderer({ node }: { node: ViewNode }): React.ReactElement {
  switch (node.type) {
    case "heading":
      return <HeadingRenderer node={node} />;
    case "markdown":
      return <MarkdownRenderer node={node} />;
    case "callout":
      return <CalloutRenderer node={node} />;
    case "keyValue":
      return <KeyValueRenderer node={node} />;
    case "table":
      return <TableRenderer node={node} />;
    case "list":
      return <ListRenderer node={node} />;
    case "tree":
      return <TreeRenderer node={node} />;
    case "code":
      return <CodeRenderer node={node} />;
    case "diff":
      return <DiffRenderer node={node} />;
    case "chart":
      return <ChartRenderer node={node} />;
    case "section":
      return <SectionRenderer node={node} />;
    case "columns":
      return <ColumnsRenderer node={node} />;
    case "image":
      return <ImageRenderer node={node} />;
    case "fileRef":
      return <FileRefRenderer node={node} />;
    default:
      return <></>;
  }
}
