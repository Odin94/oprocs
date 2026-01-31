import { useState, useRef, useEffect } from "react";

export type SearchMode = "substring" | "fuzzy" | "regex";

type SearchBarProps = {
  query: string;
  setQuery: (q: string) => void;
  mode: SearchMode;
  setMode: (m: SearchMode) => void;
  caseSensitive: boolean;
  setCaseSensitive: (v: boolean) => void;
  filterLines: boolean;
  setFilterLines: (v: boolean) => void;
  matchCount: number;
  currentMatchIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onSearch: (q: string) => void;
};

const DEBOUNCE_MS = 200;

export const SearchBar = ({
  query,
  setQuery,
  mode,
  setMode,
  caseSensitive,
  setCaseSensitive,
  filterLines,
  setFilterLines,
  matchCount,
  currentMatchIndex,
  onNext,
  onPrev,
  onSearch,
}: SearchBarProps) => {
  const [localQuery, setLocalQuery] = useState(query);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalQuery(query);
  }, [query]);

  const handleQueryChange = (value: string) => {
    setLocalQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setQuery(value);
      onSearch(value);
      debounceRef.current = null;
    }, DEBOUNCE_MS);
  };

  const inputSelectClass =
    "py-1.5 px-2.5 border border-slate-600 rounded-md bg-slate-800 text-slate-200 text-[13px] cursor-pointer";
  return (
    <div className="flex items-center gap-2 py-2 px-4 border-b border-slate-700 flex-wrap">
      <input
        type="text"
        className={`w-[200px] ${inputSelectClass}`}
        placeholder="Search..."
        value={localQuery}
        onChange={(e) => handleQueryChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (e.shiftKey) onPrev();
            else onNext();
          }
        }}
      />
      <select
        className={inputSelectClass}
        value={mode}
        onChange={(e) => setMode(e.target.value as SearchMode)}
      >
        <option value="substring">Substring</option>
        <option value="fuzzy">Fuzzy</option>
        <option value="regex">Regex</option>
      </select>
      <label className="flex items-center gap-1 text-[13px] text-slate-400">
        <input
          type="checkbox"
          checked={caseSensitive}
          onChange={(e) => setCaseSensitive(e.target.checked)}
        />
        Match case
      </label>
      <label className="flex items-center gap-1 text-[13px] text-slate-400">
        <input
          type="checkbox"
          checked={filterLines}
          onChange={(e) => setFilterLines(e.target.checked)}
        />
        Filter lines
      </label>
      {matchCount > 0 ? (
        <span className="text-[13px] text-slate-400">
          {currentMatchIndex + 1} / {matchCount}
        </span>
      ) : null}
      <button
        type="button"
        className="px-4 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer text-[13px] hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onPrev}
        disabled={matchCount === 0}
      >
        Prev
      </button>
      <button
        type="button"
        className="px-4 py-2 border border-slate-600 rounded-md bg-slate-800 text-slate-200 cursor-pointer text-[13px] hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onNext}
        disabled={matchCount === 0}
      >
        Next
      </button>
    </div>
  );
};
