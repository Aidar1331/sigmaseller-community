import type { ReactNode, MouseEvent } from 'react';

type Props = {
  nmId: number | string;
  children?: ReactNode;
  className?: string;
};

export function NmIdLink({ nmId, children, className }: Props) {
  const href = `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className ?? 'text-blue-600 hover:underline'}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
    >
      {children ?? nmId}
    </a>
  );
}

export function nmIdHref(nmId: number | string): string {
  return `https://www.wildberries.ru/catalog/${nmId}/detail.aspx`;
}
