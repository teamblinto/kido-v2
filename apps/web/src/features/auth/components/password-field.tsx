import { Eye, EyeOff, Lock } from 'lucide-react';
import { useState } from 'react';

import { TextField, type TextFieldProps } from './text-field';

type PasswordFieldProps = Omit<TextFieldProps, 'icon' | 'label' | 'trailing' | 'type'> & {
  label?: string;
};

/** Password input with a show/hide toggle. */
export function PasswordField({
  label = 'Password',
  ...props
}: PasswordFieldProps): React.JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const ToggleIcon = isVisible ? EyeOff : Eye;

  return (
    <TextField
      {...props}
      label={label}
      icon={Lock}
      type={isVisible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => {
            setIsVisible((visible) => !visible);
          }}
          aria-pressed={isVisible}
          aria-label={isVisible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="text-faint hover:text-subdued rounded-sm transition-colors"
        >
          <ToggleIcon className="size-4" aria-hidden="true" />
        </button>
      }
    />
  );
}
