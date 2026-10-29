'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Image, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceStore } from '@/store/workspace';
import { apiFetch } from '@/lib/api';
import { useDebounce } from '@/hooks/useDebounce';

// Backend returns photos as an array of size-keyed objects, not string[]:
//   { hq, tm, big, square, c246x328, c516x688 }
// Pick a thumbnail-sized url for the grid; fall back through sizes.
interface ProductPhoto {
  hq?: string;
  tm?: string;
  big?: string;
  square?: string;
  c246x328?: string;
  c516x688?: string;
}
interface Product {
  nmId: number;
  name: string;
  brand: string;
  vendorCode: string;
  photos: ProductPhoto[] | null;
}

function photoUrl(p: ProductPhoto): string {
  return p.tm || p.square || p.c246x328 || p.big || p.hq || p.c516x688 || '';
}

export default function LibraryPage() {
  const workspaceId = useWorkspaceStore((s) => s.workspaceId);
  const router = useRouter();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['studio-products', workspaceId, debouncedSearch],
    queryFn: () =>
      apiFetch(`/studio/products?workspaceId=${workspaceId}&search=${encodeURIComponent(debouncedSearch)}&limit=50`),
    enabled: !!workspaceId,
  });

  const handleSelectPhoto = (product: Product, photoUrl: string) => {
    // Navigate to editor with selected photo
    const params = new URLSearchParams({
      photo: photoUrl,
      nmId: String(product.nmId),
      name: product.name || product.vendorCode,
    });
    router.push(`/studio/editor?${params}`);
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-xl font-bold">Библиотека изображений</h1>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Поиск по названию, артикулу или бренду..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border rounded-lg bg-background"
          />
        </div>
      </div>

      {/* Products Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : !data?.products?.length ? (
        <div className="text-center py-12 border rounded-lg bg-muted/30">
          <Image className="w-12 h-12 text-muted-foreground/50 mx-auto mb-3" />
          <p className="text-muted-foreground">
            {search ? 'Товары не найдены' : 'Нет товаров в каталоге'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {data.products.map((product: Product) => (
            <div key={product.nmId} className="border rounded-lg overflow-hidden bg-card">
              {/* Product Info */}
              <div className="p-3 border-b">
                <p className="font-medium truncate" title={product.name}>
                  {product.name || product.vendorCode}
                </p>
                <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                  <span>{product.brand}</span>
                  <span>•</span>
                  <span>{product.vendorCode}</span>
                </div>
              </div>

              {/* Photos Grid */}
              <div className="p-3">
                {product.photos && product.photos.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {product.photos.slice(0, 8).map((photo, idx) => {
                      const url = photoUrl(photo);
                      if (!url) return null;
                      return (
                        <button
                          key={idx}
                          onClick={() => handleSelectPhoto(product, url)}
                          className="aspect-square bg-muted rounded overflow-hidden hover:ring-2 ring-primary transition-all"
                          title={`Фото ${idx + 1}`}
                        >
                          <img
                            src={url}
                            alt={`${product.name} - фото ${idx + 1}`}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-4 text-sm text-muted-foreground">
                    Нет фото
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
