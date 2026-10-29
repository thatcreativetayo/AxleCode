export const GITHUB_OAUTH_SCOPE = "repo";

export function githubUserRepositoriesPath(page: number): string {
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
  return `/user/repos?visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&sort=updated&direction=desc&page=${normalizedPage}`;
}

export function githubRepositoryPath(repository: string): string {
  const [owner = "", name = ""] = repository.split("/");
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function githubRepositoryBranchesPath(repository: string, page: number): string {
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
  return `${githubRepositoryPath(repository)}/branches?per_page=100&page=${normalizedPage}`;
}
