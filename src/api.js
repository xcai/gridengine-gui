export default async function apiFetch(...args) {
  const response = await window.fetch(...args)
  if (response.status === 401) window.dispatchEvent(new Event('session-expired'))
  return response
}