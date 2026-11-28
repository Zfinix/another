import { use, type ComponentPropsWithRef, type ReactNode } from "react";
import { OTPInput, OTPInputContext, REGEXP_ONLY_DIGITS } from "input-otp";
import { cn } from "@/lib/utils";

type InputOTPProps = Omit<ComponentPropsWithRef<typeof OTPInput>, "render" | "containerClassName" | "children"> & {
  children: ReactNode;
};

/** HeroUI v3's InputOTP on top of input-otp: same parts, classes and data attributes. */
function InputOTPRoot({ className, children, disabled, pattern = REGEXP_ONLY_DIGITS, ...props }: InputOTPProps) {
  return (
    <OTPInput
      {...props}
      pattern={pattern}
      disabled={disabled}
      containerClassName={cn("input-otp", disabled && "input-otp--disabled", className)}
    >
      {children}
    </OTPInput>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="input-otp__group">{children}</div>;
}

function Slot({ index }: { index: number }) {
  const { char, hasFakeCaret, isActive } = use(OTPInputContext)?.slots[index] ?? {};
  return (
    <div className="input-otp__slot" data-active={isActive ? "true" : undefined} data-filled={char ? "true" : undefined}>
      {char ? <div className="input-otp__slot-value">{char}</div> : null}
      {hasFakeCaret && isActive ? <div className="input-otp__caret" /> : null}
    </div>
  );
}

function Separator() {
  return <div className="input-otp__separator" role="separator" />;
}

export const InputOTP = Object.assign(InputOTPRoot, { Group, Slot, Separator });
