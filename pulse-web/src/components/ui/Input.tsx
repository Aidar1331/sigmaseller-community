'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';
import { Search, X } from 'lucide-react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  onClear?: () => void;
  error?: boolean;
  hint?: string;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, icon, rightIcon, onClear, error, hint, value, ...props }, ref) => {
    const showClear = onClear && value && String(value).length > 0;
    
    const baseStyles = cn(
      'flex w-full rounded-xl border bg-white text-sm text-gray-900',
      'placeholder:text-gray-400',
      'transition-all duration-200 ease-out',
      'focus:outline-none focus:ring-2 focus:ring-offset-1',
      error
        ? 'border-red-300 focus:border-red-500 focus:ring-red-200'
        : 'border-gray-300 hover:border-gray-400 focus:border-indigo-500 focus:ring-indigo-200',
      'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50'
    );

    if (icon || type === 'search' || showClear || rightIcon) {
      return (
        <div className="relative">
          {(icon || type === 'search') && (
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-500">
              {icon || <Search className="h-4 w-4" />}
            </div>
          )}
          
          <input
            type={type}
            value={value}
            className={cn(
              baseStyles,
              'h-10',
              (icon || type === 'search') ? 'pl-10' : 'pl-3',
              (showClear || rightIcon) ? 'pr-10' : 'pr-3',
              className
            )}
            ref={ref}
            {...props}
          />
          
          {showClear ? (
            <button
              type="button"
              onClick={onClear}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500 hover:text-gray-600 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          ) : rightIcon ? (
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-gray-500">
              {rightIcon}
            </div>
          ) : null}
          
          {hint && (
            <p className={cn('mt-1.5 text-xs', error ? 'text-red-600' : 'text-gray-500')}>
              {hint}
            </p>
          )}
        </div>
      );
    }

    return (
      <div>
        <input
          type={type}
          value={value}
          className={cn(baseStyles, 'h-10 px-3', className)}
          ref={ref}
          {...props}
        />
        {hint && (
          <p className={cn('mt-1.5 text-xs', error ? 'text-red-600' : 'text-gray-500')}>
            {hint}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = 'Input';

/* ----------  Textarea ---------- */

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
  hint?: string;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, hint, ...props }, ref) => {
    return (
      <div>
        <textarea
          className={cn(
            'flex min-h-[100px] w-full rounded-xl border bg-white px-3 py-2.5 text-sm text-gray-900',
            'placeholder:text-gray-400',
            'transition-all duration-200 ease-out',
            'focus:outline-none focus:ring-2 focus:ring-offset-1',
            error
              ? 'border-red-300 focus:border-red-500 focus:ring-red-200'
              : 'border-gray-300 hover:border-gray-400 focus:border-indigo-500 focus:ring-indigo-200',
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-50',
            'resize-none',
            className
          )}
          ref={ref}
          {...props}
        />
        {hint && (
          <p className={cn('mt-1.5 text-xs', error ? 'text-red-600' : 'text-gray-500')}>
            {hint}
          </p>
        )}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';

export { Input, Textarea };
