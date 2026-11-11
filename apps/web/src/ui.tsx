import { ChevronDownIcon } from '@heroicons/react/20/solid';
import {
  Button as HeroButton,
  Table,
  type ButtonProps as HeroButtonProps,
} from '@heroui/react';
import { useContext, type ComponentPropsWithRef, type ReactNode } from 'react';
import { PreviewMode } from './previewMode.js';

export { Input, TextArea } from '@heroui/react';

type ButtonProps = Omit<HeroButtonProps, 'isDisabled'> & {
  disabled?: boolean | undefined;
  liveAction?: boolean;
};

// Keep native event handlers and form submission while HeroUI owns interaction states.
export function Button({
  disabled,
  liveAction = false,
  variant = 'secondary',
  size = 'md',
  ...props
}: ButtonProps) {
  const preview = useContext(PreviewMode);
  return (
    <HeroButton
      {...props}
      isDisabled={
        Boolean(disabled) ||
        (preview && (liveAction || props.type === 'submit'))
      }
      variant={variant}
      size={size}
    />
  );
}

// Native selects preserve the existing FormData and platform keyboard behavior.
export function NativeSelect({
  className = '',
  ...props
}: ComponentPropsWithRef<'select'>) {
  return (
    <span className="select select--primary ui-native-select">
      <select {...props} className={`select__trigger ${className}`} />
      <ChevronDownIcon className="select__indicator" aria-hidden="true" />
    </span>
  );
}

// Grouped recipe tables keep their native row/column semantics inside HeroUI's surface.
export function TableSurface({ children }: { children: ReactNode }) {
  return <Table className="ui-table-surface">{children}</Table>;
}
