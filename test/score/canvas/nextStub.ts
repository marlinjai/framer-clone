// next/navigation, next/headers and next/cache for the mounted canvas probe. There
// is no Next.js server on that page, so a router call does nothing and a server
// read says so instead of returning something plausible.

const nothing = (): void => undefined;
const router = { push: nothing, replace: nothing, refresh: nothing, back: nothing, forward: nothing, prefetch: nothing };

export const useRouter = () => router;
export const usePathname = () => '/';
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export const redirect = (url: string) => {
  throw new Error(`redirect to ${url} in the score harness`);
};
export const notFound = () => {
  throw new Error('notFound in the score harness');
};
export const headers = () => {
  throw new Error('headers() has no server in the score harness');
};
export const cookies = headers;
export const revalidatePath = nothing;
export const revalidateTag = nothing;
