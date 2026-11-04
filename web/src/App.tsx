import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SessionExpiredError, searchImages, thumbnailUrl, type Image, type SearchMode } from "./api";

interface Search {
  q: string;
  mode: SearchMode;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string; expired: boolean }
  | { kind: "done"; items: Image[]; nextCursor: string | null; loadingMore: boolean };

/** The search lives in the URL, so back/forward and bookmarks work. */
function readSearch(): Search {
  const params = new URLSearchParams(window.location.search);
  return { q: params.get("q") ?? "", mode: params.get("mode") === "any" ? "any" : "all" };
}

function writeSearch(s: Search) {
  const params = new URLSearchParams();
  if (s.q) params.set("q", s.q);
  if (s.mode === "any") params.set("mode", "any");
  const qs = params.toString();
  window.history.pushState(null, "", qs ? `?${qs}` : window.location.pathname);
}

function toError(err: unknown): State {
  return {
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
    expired: err instanceof SessionExpiredError,
  };
}

export function App() {
  const [search, setSearch] = useState<Search>(readSearch);
  const [input, setInput] = useState(search.q);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [selected, setSelected] = useState<Image | null>(null);

  useEffect(() => {
    const onPop = () => {
      const s = readSearch();
      setSearch(s);
      setInput(s.q);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!search.q.trim()) {
      setState({ kind: "idle" });
      return;
    }
    const ctrl = new AbortController();
    setState({ kind: "loading" });
    searchImages(search.q, search.mode, null, ctrl.signal)
      .then((r) => setState({ kind: "done", items: r.items, nextCursor: r.nextCursor, loadingMore: false }))
      .catch((err) => {
        if (!ctrl.signal.aborted) setState(toError(err));
      });
    return () => ctrl.abort();
  }, [search]);

  const submit = (s: Search) => {
    setSearch(s);
    setInput(s.q);
    writeSearch(s);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit({ ...search, q: input.trim() });
  };

  const loadMore = useCallback(async () => {
    if (state.kind !== "done" || !state.nextCursor || state.loadingMore) return;
    setState({ ...state, loadingMore: true });
    try {
      const r = await searchImages(search.q, search.mode, state.nextCursor);
      setState({ kind: "done", items: [...state.items, ...r.items], nextCursor: r.nextCursor, loadingMore: false });
    } catch (err) {
      setState(toError(err));
    }
  }, [state, search]);

  return (
    <div className="app">
      <header>
        <form onSubmit={onSubmit} role="search">
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search photos, e.g. dog beach"
            aria-label="Search keywords"
            autoFocus
          />
          <button type="submit">Search</button>
        </form>
        <fieldset className="mode">
          <label>
            <input
              type="radio"
              name="mode"
              checked={search.mode === "all"}
              onChange={() => submit({ ...search, mode: "all" })}
            />
            All words
          </label>
          <label>
            <input
              type="radio"
              name="mode"
              checked={search.mode === "any"}
              onChange={() => submit({ ...search, mode: "any" })}
            />
            Any word
          </label>
        </fieldset>
      </header>

      <main>
        {state.kind === "idle" && <p className="hint">Type keywords to find photos.</p>}
        {state.kind === "loading" && <p className="hint">Searching…</p>}
        {state.kind === "error" && (
          <div className="error">
            <p>{state.message}</p>
            {state.expired && <button onClick={() => window.location.reload()}>Sign in again</button>}
          </div>
        )}
        {state.kind === "done" && (
          <>
            <p className="hint">
              {state.items.length === 0
                ? "No photos found."
                : `${state.items.length}${state.nextCursor ? "+" : ""} photos`}
            </p>
            <ul className="grid">
              {state.items.map((img) => (
                <li key={img.id}>
                  <button onClick={() => setSelected(img)} title={img.keywords.join(", ")}>
                    <img src={thumbnailUrl(img, "small")} alt={img.keywords.slice(0, 5).join(", ")} loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
            {state.nextCursor && (
              <button className="more" onClick={loadMore} disabled={state.loadingMore}>
                {state.loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
      </main>

      {selected && (
        <Viewer
          img={selected}
          onClose={() => setSelected(null)}
          onKeyword={(k) => {
            setSelected(null);
            submit({ q: k, mode: "all" });
          }}
        />
      )}
    </div>
  );
}

function Viewer({ img, onClose, onKeyword }: { img: Image; onClose: () => void; onKeyword: (k: string) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={img.name} onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <img src={thumbnailUrl(img, "large")} alt={img.keywords.slice(0, 5).join(", ")} />
        <figcaption>
          <div className="meta">
            <strong>{img.name}</strong>
            <span>{img.path}</span>
            <span>{new Date(img.modifiedAt).toLocaleString()}</span>
          </div>
          <ul className="keywords">
            {img.keywords.map((k) => (
              <li key={k}>
                <button onClick={() => onKeyword(k)}>{k}</button>
              </li>
            ))}
          </ul>
        </figcaption>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </figure>
    </div>
  );
}
