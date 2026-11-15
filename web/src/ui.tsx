import { useId, useState, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Check, Copy, LoaderCircle, X } from "lucide-react";
import { message } from "./api";
import { initials, skillLabel, skills } from "./model";
import type { Commands } from "./commands";

export function CommandFeedback({ commands }: { commands: Commands }) {
  return (
    <>
      {!!commands.error && <ErrorBox error={commands.error} />}
      {commands.pending && !commands.busy && (
        <div className="error-box" role="status">
          <p>
            The outcome is unconfirmed. Review the action in your workspace
            before trying anything else.
          </p>
          <Dialog.Close asChild>
            <button className="button button-outline button-small">
              Review unconfirmed action
            </button>
          </Dialog.Close>
        </div>
      )}
    </>
  );
}

export function Brand() {
  const event = new URLSearchParams(location.search).get("event");
  return (
    <a
      href={event ? `/?event=${encodeURIComponent(event)}` : "/"}
      className="brand"
      aria-label="CrewHQ home"
    >
      <img src="/mark.svg" alt="" width="34" height="34" />
      <span>
        Crew<span className="brand-light">HQ</span>
        <span className="brand-dot">.</span>
      </span>
    </a>
  );
}
export function Avatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${small ? "avatar-small" : ""}`}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
export function Tags({
  values,
  muted = false,
}: {
  values: string[];
  muted?: boolean;
}) {
  return (
    <div className="tags">
      {values.map((value) => (
        <span className={`tag ${muted ? "tag-muted" : ""}`} key={value}>
          {skillLabel(value)}
        </span>
      ))}
    </div>
  );
}
export function SkillPicker({
  label,
  value,
  onChange,
  max,
}: {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  max: number;
}) {
  const id = useId();
  return (
    <fieldset className="skill-picker">
      <legend>
        {label}{" "}
        <span className="hint">
          {value.length}/{max}
        </span>
      </legend>
      <p id={id} className="hint">
        Choose up to {max}. You can change these later.
      </p>
      <div className="tags">
        {skills.map((skill) => (
          <label
            className={`skill-option ${value.includes(skill) ? "selected" : ""}`}
            key={skill}
          >
            <input
              type="checkbox"
              checked={value.includes(skill)}
              disabled={!value.includes(skill) && value.length >= max}
              onChange={() =>
                onChange(
                  value.includes(skill)
                    ? value.filter((v) => v !== skill)
                    : [...value, skill],
                )
              }
              aria-describedby={id}
            />
            {skillLabel(skill)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export function Busy({ text = "Loading workspace…" }: { text?: string }) {
  return (
    <div className="busy" role="status">
      <LoaderCircle size={18} className="spin" />
      {text}
    </div>
  );
}
export function ErrorBox({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <p>{message(error)}</p>
      {retry && (
        <button className="button button-small button-outline" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark" aria-hidden="true">
        ↗
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Modal({
  title,
  description,
  trigger,
  children,
  open,
  onOpenChange,
}: {
  title: string;
  description: string;
  trigger?: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger && <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" aria-label="Close dialog">
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div>
      <button
        className="button button-outline button-small"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              setFailed(false);
            },
            () => setFailed(true),
          );
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied ? "Copied" : label}
      </button>
      {failed && (
        <p role="status" className="hint">
          Select the text and copy it manually.
        </p>
      )}
    </div>
  );
}
export function SubmitButton({
  busy,
  disabled = false,
  children = "Save changes",
}: {
  busy: boolean;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="submit"
      className="button button-primary"
      disabled={busy || disabled}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
      {!busy && <ArrowRight size={16} />}
    </button>
  );
}
export function formAction(handler: () => Promise<unknown>) {
  return (event: FormEvent) => {
    event.preventDefault();
    void handler();
  };
}
