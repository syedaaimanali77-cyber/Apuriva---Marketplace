import { serializeJsonLd } from '@/lib/seo/json-ld';

/** Spec 044 §3.9 — schema.org structured data for a server layout, escaped against `</script>`. */
export function JsonLd({ data }: { data: readonly Record<string, unknown>[] }) {
  return (
    <>
      {data.map((item, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(item) }} />
      ))}
    </>
  );
}
