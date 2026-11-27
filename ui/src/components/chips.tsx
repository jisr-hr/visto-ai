import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

// The mockup's .chip (Settings.dc.html): a list of names, each removed by its button, and one added by name.
export const CHIP = 'inline-flex items-center gap-1.5 rounded-[7px] bg-subtle py-1 pr-1.5 pl-2.5 font-mono text-[13px]';

export function Chips({
  label,
  values,
  onChange,
  addLabel = 'Add',
  empty,
}: {
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  addLabel?: string;
  empty?: string;
}) {
  const [adding, setAdding] = useState(false);
  // Set when the input closes, so focus goes back to the button that opens it, once it is there.
  const back = useRef(false);
  const add = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!adding && back.current) {
      back.current = false;
      add.current?.focus();
    }
  }, [adding]);

  const close = (): void => {
    back.current = true;
    setAdding(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {values.map((value) => (
        <span key={value} className={CHIP}>
          {value}
          <button
            type="button"
            aria-label={`Remove ${value}`}
            className="size-[22px] cursor-pointer rounded-[5px] border-0 bg-transparent font-sans text-sm font-medium text-muted"
            onClick={() => onChange(values.filter((other) => other !== value))}
          >
            x
          </button>
        </span>
      ))}
      {values.length === 0 && empty !== undefined && <span className={`${CHIP} text-muted`}>{empty}</span>}
      {adding ? (
        <Input
          aria-label={`Add to ${label}`}
          className="w-[180px] font-mono"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              const text = event.currentTarget.value.trim();
              if (text !== '' && !values.includes(text)) onChange([...values, text]);
              close();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        />
      ) : (
        <Button ref={add} type="button" onClick={() => setAdding(true)}>
          {addLabel}
        </Button>
      )}
    </div>
  );
}
