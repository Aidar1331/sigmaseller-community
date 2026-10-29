'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 rounded-xl font-medium
   transition-all duration-200 ease-out
   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
   disabled:pointer-events-none disabled:opacity-50`,
  {
    variants: {
      variant: {
        // Primary — gradient with shadow
        primary: `
          bg-gradient-to-r from-indigo-500 to-indigo-600
          text-white font-semibold
          shadow-md shadow-indigo-200
          hover:shadow-lg hover:shadow-indigo-300 hover:-translate-y-0.5
          active:translate-y-0 active:shadow-md
          focus-visible:ring-indigo-500
        `,
        // Secondary — subtle background
        secondary: `
          bg-gray-100 text-gray-700
          hover:bg-gray-200 hover:text-gray-900
          active:bg-gray-300
          focus-visible:ring-gray-500
        `,
        // Neutral — alias for secondary
        neutral: `
          bg-gray-100 text-gray-700
          hover:bg-gray-200 hover:text-gray-900
          active:bg-gray-300
          focus-visible:ring-gray-500
        `,
        // Ghost — minimal
        ghost: `
          text-gray-600
          hover:bg-gray-100 hover:text-gray-900
          active:bg-gray-200
          focus-visible:ring-gray-500
        `,
        // Danger — red
        danger: `
          bg-gradient-to-r from-red-500 to-red-600
          text-white font-semibold
          shadow-md shadow-red-200
          hover:shadow-lg hover:shadow-red-300 hover:-translate-y-0.5
          active:translate-y-0 active:shadow-md
          focus-visible:ring-red-500
        `,
        // Success — green
        success: `
          bg-gradient-to-r from-emerald-500 to-emerald-600
          text-white font-semibold
          shadow-md shadow-emerald-200
          hover:shadow-lg hover:shadow-emerald-300 hover:-translate-y-0.5
          active:translate-y-0 active:shadow-md
          focus-visible:ring-emerald-500
        `,
        // Outline — bordered
        outline: `
          bg-white text-gray-700
          border border-gray-300
          hover:bg-gray-50 hover:border-gray-400
          active:bg-gray-100
          focus-visible:ring-gray-500
        `,
        // Link — text only
        link: `
          text-indigo-600 underline-offset-4
          hover:text-indigo-700 hover:underline
          focus-visible:ring-indigo-500
        `,
      },
      size: {
        xs: 'h-7 px-2.5 text-xs',
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-11 px-5 text-sm',
        xl: 'h-12 px-6 text-base',
        icon: 'h-10 w-10',
        'icon-sm': 'h-8 w-8',
        'icon-lg': 'h-12 w-12',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, leftIcon, rightIcon, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : leftIcon ? (
          <span className="shrink-0">{leftIcon}</span>
        ) : null}
        {children}
        {rightIcon && !loading && (
          <span className="shrink-0">{rightIcon}</span>
        )}
      </button>
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
