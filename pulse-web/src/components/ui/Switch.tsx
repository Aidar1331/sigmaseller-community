'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/cn';

interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label?: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
}

const Switch = React.forwardRef<React.ComponentRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, label, description, size = 'md', id, ...props }, ref) => {
    const generatedId = React.useId();
    const switchId = id || generatedId;

    const sizeStyles = {
      sm: { root: 'h-4 w-7', thumb: 'h-3 w-3 data-[state=checked]:translate-x-3' },
      md: { root: 'h-5 w-9', thumb: 'h-4 w-4 data-[state=checked]:translate-x-4' },
      lg: { root: 'h-6 w-11', thumb: 'h-5 w-5 data-[state=checked]:translate-x-5' },
    };

    const sizes = sizeStyles[size];

    const switchElement = (
      <SwitchPrimitive.Root
        className={cn(
          'peer inline-flex shrink-0 cursor-pointer items-center rounded-full',
          'transition-all duration-200 ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-200 focus-visible:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'data-[state=checked]:bg-indigo-600',
          'data-[state=unchecked]:bg-gray-200',
          sizes.root,
          className
        )}
        id={switchId}
        ref={ref}
        {...props}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'pointer-events-none block rounded-full bg-white shadow-md',
            'transition-transform duration-200 ease-out',
            'data-[state=unchecked]:translate-x-0.5',
            sizes.thumb
          )}
        />
      </SwitchPrimitive.Root>
    );

    if (label || description) {
      return (
        <div className="flex items-start gap-3">
          <div className="pt-0.5">{switchElement}</div>
          <div className="flex flex-col">
            {label && (
              <label htmlFor={switchId} className="text-sm font-medium text-gray-700 cursor-pointer select-none">
                {label}
              </label>
            )}
            {description && <span className="text-xs text-gray-500 mt-0.5">{description}</span>}
          </div>
        </div>
      );
    }

    return switchElement;
  }
);
Switch.displayName = 'Switch';

export { Switch };
