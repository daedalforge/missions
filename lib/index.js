import { homedir } from 'node:os'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ArchiveError, archiveMany, archiveMission } from './archive.js'
import { attachBranches, declarationFor, loadBranches, saveDeclaration, writeAtomically } from './branches.js'
import { attachPins, loadPins, savePin } from './pins.js'
import { CHECKLIST_FILE, readChecklist } from './checklist.js'
import { JOURNAL_FILE, readJournal } from './journal.js'
import { HttpError } from './http.js'
import { LocalCloseError, closeLocal, planClose, readProof } from './local-close.js'
import { POINTS_SCALE } from './mission.js'
import { PlaybookError, listPlaybooks, readPlaybook, savePlaybook } from './playbooks.js'
import { defaultProjectsFile, loadCanonical, loadProjects, readerFor, resolveMissionProject, trackerForKey } from './projects.js'
import { adoptWorktree, countRepositories, listRepositories, readHistory, readRepository, removeWorktree, summarizeRepositories } from './repositories.js'
import { IMPORT_FILE, TolgeeError, planImport } from './tolgee.js'
import { buildXliff } from './tolgee-xliff.js'
import { readUsage, recordUsage, usagePath } from './usage.js'
import { parseChecklist } from './view.js'
import { LOCAL_MODEL_DIR, MODEL_DIR, WRITERS, createWorkflow, isWorkflowKey, loadWorkflows, readWorkflow, saveWorkflow, workflowDirs } from './workflows.js'
import { findWorkspaceId } from './workspaces.js'
import { create as createTrackerMission, forget, listAll, listEpics, pointsOf, setBlocked, setPoints, setPriority } from './trackers/index.js'

/**
 * Host half of the Missions panel.
 *
 * It alone talks to the trackers: it holds the tokens, reads the projects
 * declared in `missions/projects.yml`, and exposes a normalized list to the
 * client, which never sees a secret.
 */
export const name = '@daedalforge/dsh-missions'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const configuredProjectsFile = config?.projectsFile ? new URL(config.projectsFile, 'file:///') : undefined
  const projectsFile = configuredProjectsFile ?? defaultProjectsFile()
  // Mission folders sit next to `projects.yml`; a custom projects file brings
  // its own declarations along. The root always follows the projects file,
  // default or configured: the writes build paths from it, and a route must
  // never derive a URL from an undefined directory.
  const branchesDir = new URL('./', projectsFile)
  // The workflow models live next to `projects.yml`, in the method repository:
  // a custom projects file brings its own models along. Without one, both
  // directories are the package's own — the ones the reads already defaulted
  // to, so the writes land beside the files the panel lists.
  // `projects.yml` vit dans `missions/` ; les modèles du parcours dans
  // `workflows/model/`, à côté des documents qu'ils décrivent. Les locaux sont
  // leur jumeau git-ignoré, `workflows/local/model/` : le dossier, jamais un
  // champ du modèle, dit ce qui est versionné.
  const { modelsDir, localModelsDir } = workflowDirs(configuredProjectsFile)
  // The playbook pages sit next to `projects.yml`, at the root of the method
  // repository: a custom projects file brings its own playbook along. The
  // folder is the host's, never the request's — a page is named by its key.
  const playbookDir = new URL('../playbook/', projectsFile)
  // Where a session started from the panel lands: the code workspace, never the
  // method repository.
  const workspaceRoot = String(config?.workspaceRoot || join(homedir(), 'projects'))
  // Tests pass a fake `fetch`: no test writes to a real tracker.
  const fetchImpl = config?.fetchImpl ?? fetch
  // Tests pass a fake git runner: no test spawns a process, and the scan is
  // exercised on fixtures instead of the machine's repositories.
  const runGit = config?.runGit
  // Tests pass a fake clock: the freshly created row's window is proved without
  // waiting five minutes.
  const now = config?.now ?? Date.now

  /**
   * Read every tracker once, then give each row the repository its folder
   * declares. A board is a tracker, not a project: the board's read never
   * filters repositories, and every row offers every declared repository. A
   * row no folder claims keeps `project: null` and is shown as-is.
   */
  const readTrackers = async (trackers, projects, { declarations = new Map(), ...options } = {}) => {
    const choices = projects.map((project) => ({ id: project.id, name: project.name, repo: project.repo }))
    const settled = await Promise.allSettled(trackers.map(async (tracker) => {
      const reader = readerFor(tracker)
      const result = await listAll([reader], options)
      const missions = result.missions.flatMap((mission) => {
        // A key may be worked in two repositories at once: each declaration is
        // its own mission line, with its own repository. Without a declaration
        // the mission has no repository: nothing is borrowed from the board.
        const declared = declarations.get(mission.key)
        const targets = declared && declared.length > 0
          ? declared.map((id) => (id ? projects.find((entry) => entry.id === id) ?? null : null))
          : [null]
        const unique = new Map(targets.map((project) => [project?.id ?? '', project]))
        return [...unique.values()].map((project) => ({
          ...mission,
          project: project?.id ?? null,
          projectName: project?.name ?? null,
          repo: project?.repo ?? null,
          translations: project?.translations ?? null,
          trackerId: tracker.id,
          trackerName: tracker.name,
          projectChoices: choices,
        }))
      })
      return { missions, errors: result.errors }
    }))

    const missions = []
    const errors = []
    settled.forEach((entry, position) => {
      if (entry.status === 'rejected') {
        errors.push({ project: trackers[position].id, message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) })
        return
      }
      missions.push(...entry.value.missions)
      errors.push(...entry.value.errors)
    })
    missions.sort(
      (left, right) => String(left.state ?? 'zzz').localeCompare(String(right.state ?? 'zzz')) || left.key.localeCompare(right.key),
    )
    return { missions, errors }
  }

  /**
   * The board a key names: a mission's key carries its tracker's reference, so
   * the board is enough to write blocked, priority and points. No repository is
   * read here — those routes work on the tracker's own fields.
   */
  const boardFor = (trackers, key) => {
    const tracker = trackerForKey(trackers, key)
    if (!tracker) throw new HttpError(`no project declares ${key}`, { status: 404 })
    return tracker
  }

  // Journal and checklist live in the mission folders, not in projects.yml:
  // when a configuration is present it is used to resolve a folder declared
  // before the split, but its absence must not hide the journal.
  const loadDeclarations = async () => {
    try {
      const { projects, trackers } = await loadProjects(projectsFile)
      return await loadBranches(branchesDir, { projects })
    } catch {
      return await loadBranches(branchesDir)
    }
  }

  const list = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      const { projects, trackers } = await loadProjects(projectsFile)
      const refresh = url.searchParams.get('refresh') === '1'
      // Done is its own perimeter: `?done=1` selects the closed read, which the
      // panel pays when the Done tab opens. Without it the route only reads
      // open work, whatever folders the machine declares. The badge's count is
      // not here — it has its own route below, and answers a number, not lines.
      const scope = url.searchParams.get('done') === '1' ? 'done' : 'open'
      // Branch and base are declared per mission, in the mission folders: the
      // trackers do not carry them, and nothing derives them from the repo.
      // The same folders say which done missions the panel may still show, so
      // they are read before the trackers.
      const [{ index, byProject, projectsByKey, errors: branchErrors }, { pinned, errors: pinErrors }] = await Promise.all([
        loadBranches(branchesDir, { projects }),
        loadPins(branchesDir),
      ])
      const { missions, errors } = await readTrackers(trackers, projects, {
        refresh,
        fetchImpl,
        declaredKeys: new Set(index.keys()),
        declarations: projectsByKey,
        scope,
        now,
      })
      return send(res, 200, {
        missions: attachPins(attachBranches(missions, index, byProject), pinned),
        errors: [...errors, ...branchErrors, ...pinErrors],
        workspaceRoot,
        workspaceId: await resolveWorkspaceId(ctx, workspaceRoot),
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // How many missions the machine declares and the trackers say are done: the
  // Done badge's number. The panel reads it at mount and only the closed lines
  // when the tab opens, so this route answers a count, never the rows. It asks
  // the trackers with the Done read's own perimeter — the declared keys — and
  // shares that read even when the tab opens at the same instant: the badge and
  // the rows agree without a second tracker round-trip.
  const doneCount = async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      const { projects, trackers } = await loadProjects(projectsFile)
      const bundle = await loadBranches(branchesDir, { projects })
      const { missions, errors } = await readTrackers(trackers, projects, {
        fetchImpl,
        declaredKeys: new Set(bundle.index.keys()),
        declarations: bundle.projectsByKey,
        scope: 'done',
      })
      // A broken declaration makes the perimeter itself partial: the count is
      // then a number the panel must not show, so it travels with its errors.
      return send(res, 200, { count: missions.length, errors: [...errors, ...bundle.errors] })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'count failed' })
    }
  }

  // Declarations are local to this checkout: `missions/*/` is ignored by git,
  // so this route writes files and never touches git.
  const declare = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let declaration
    try {
      declaration = await readJson(req)
    } catch (error) {
      // A body we refused to read is still in flight: close the connection so
      // the client stops uploading after receiving the 400.
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }
    try {
      return send(res, 200, await saveDeclaration(branchesDir, declaration))
    } catch (error) {
      return send(res, error?.status ?? 500, { error: error instanceof Error ? error.message : 'write failed' })
    }
  }

  // A pin is a reading preference of this checkout, not a tracker field: it is
  // stored beside the mission declarations, in `pins.yml`, never versioned.
  const pin = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      // A body we refused to read is still in flight: close the connection so
      // the client stops uploading after receiving the 400.
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }
    try {
      return send(res, 200, await savePin(branchesDir, payload))
    } catch (error) {
      return send(res, error?.status ?? 500, { error: error instanceof Error ? error.message : 'write failed' })
    }
  }

  // The panel's one write towards a tracker: the blocked label, and the reason
  // as a comment. Nothing is stored locally — clearing the label writes nothing
  // else, and the next read shows the tracker's own answer.
  const blocked = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const key = String(payload?.key ?? '').trim()
    const isBlocked = payload?.blocked === true
    const message = String(payload?.message ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })
    // A block without its reason is a label nobody can explain: refuse it.
    if (isBlocked && !message) return send(res, 400, { error: 'a reason is required to block a mission' })

    let tracker
    try {
      const { trackers } = await loadProjects(projectsFile)
      tracker = boardFor(trackers, key)
    } catch (error) {
      // A refusal decided here is a message for the panel, not an upstream one.
      return send(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'projects.yml could not be read',
      })
    }
    try {
      const result = await setBlocked(readerFor(tracker), key, { blocked: isBlocked, message, fetchImpl })
      return send(res, 200, { ...result, project: null })
    } catch (error) {
      // The tracker refused: that is upstream, not a bad request from the panel.
      return send(res, 502, { error: error instanceof Error ? error.message : 'tracker write failed' })
    }
  }

  // The panel's second write towards a tracker: one priority. The panel sends a
  // canonical word; the project's map owns the tracker's own name (`priority:high`
  // here, `High` there), so the client never learns it.
  const priority = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const key = String(payload?.key ?? '').trim()
    const value = String(payload?.priority ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })
    if (!value) return send(res, 400, { error: 'priority is missing' })

    let reader
    let trackerValue
    try {
      const { canonical, trackers } = await loadProjects(projectsFile)
      if (!canonical.priorities.includes(value)) return send(res, 400, { error: `unknown priority: ${value}` })
      const tracker = boardFor(trackers, key)
      reader = readerFor(tracker)
      trackerValue = reader.map?.priorities?.[value] ?? null
      if (trackerValue === null || trackerValue === '') {
        return send(res, 400, { error: `priority ${value} has no tracker value for ${tracker.id}` })
      }
    } catch (error) {
      return send(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'projects.yml could not be read',
      })
    }
    try {
      const result = await setPriority(reader, key, { value: trackerValue, fetchImpl })
      return send(res, 200, { ...result, priority: value, project: null })
    } catch (error) {
      // The tracker refused: that is upstream, not a bad request from the panel.
      return send(res, 502, { error: error instanceof Error ? error.message : 'tracker write failed' })
    }
  }

  // The panel's third write towards a tracker: the estimation. The session sends
  // a size of the workspace scale, never the tracker's own form; the project
  // owns it (`sp:N` on GitHub, the story-points field on Jira), so the route
  // learns it from the adapter and refuses a project that cannot hold it before
  // any tracker call.
  const points = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const key = String(payload?.key ?? '').trim()
    const value = payload?.points
    if (!key) return send(res, 400, { error: 'key is missing' })
    if (value === undefined || value === null || value === '') return send(res, 400, { error: 'points is missing' })
    const estimation = Number(value)
    if (!POINTS_SCALE.includes(estimation)) return send(res, 400, { error: `unknown points: ${value}` })

    let reader
    try {
      const { trackers } = await loadProjects(projectsFile)
      reader = readerFor(boardFor(trackers, key))
      if (!pointsOf(reader)) return send(res, 400, { error: `points have no tracker value for ${reader.id}` })
    } catch (error) {
      return send(res, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : 'projects.yml could not be read',
      })
    }
    try {
      const result = await setPoints(reader, key, { points: estimation, fetchImpl })
      return send(res, 200, { ...result, points: estimation, project: null })
    } catch (error) {
      // The tracker refused: that is upstream, not a bad request from the panel.
      return send(res, 502, { error: error instanceof Error ? error.message : 'tracker write failed' })
    }
  }

  // The creation form's options: the boards a mission can land on, and every
  // repository it can be worked in. The two lists are separate — the board owns
  // the vocabulary, the repository owns the checkout — and every board is
  // offered, even one no repository points at. The form never reads the mission
  // list to populate itself (D1).
  const createOptions = async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      const { canonical, projects, trackers } = await loadProjects(projectsFile)
      return send(res, 200, {
        status: 'to-refine',
        defaultPriority: canonical.priorities.includes('normal') ? 'normal' : (canonical.priorities[0] ?? null),
        trackers: trackers.map((tracker) => ({
          id: tracker.id,
          name: tracker.name,
          tracker: tracker.tracker,
          types: canonical.types.filter((type) => type in (tracker.map?.types ?? {})),
          priorities: canonical.priorities.filter((priority) => priority in (tracker.map?.priorities ?? {})),
        })),
        repositories: projects.map((project) => ({ id: project.id, name: project.name, repo: project.repo })),
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The epics of one board, asked only once a board is chosen (D4). The epics
  // live on the board, not on a repository, so the route takes a tracker id. A
  // tracker refusal is upstream: the form shows it and still allows "No epic".
  const createEpics = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const wanted = String(url.searchParams.get('tracker') ?? '').trim()
    if (!wanted) return send(res, 400, { error: 'tracker is missing' })
    try {
      const { trackers } = await loadProjects(projectsFile)
      const tracker = trackers.find((entry) => entry.id === wanted)
      if (!tracker) return send(res, 404, { error: `unknown tracker: ${wanted}` })
      const epics = await listEpics(readerFor(tracker), { fetchImpl })
      return send(res, 200, { tracker: tracker.id, epics })
    } catch (error) {
      return send(res, 502, { error: error instanceof Error ? error.message : 'tracker read failed' })
    }
  }

  // One mission, from the canonical payload only: the route owns the state
  // (`to-refine`, never the client's), validates the board's own vocabulary,
  // then lets the tracker write. Two fields, two owners: `tracker` is the board
  // that receives the issue, `project` the repository that will work it. The
  // repository is declared in the mission folder right after the issue exists —
  // never before, and its failure never unsends the issue.
  const createMission = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const wantedTracker = String(payload?.tracker ?? '').trim()
    const wantedProject = String(payload?.project ?? '').trim()
    const title = String(payload?.title ?? '').trim()
    const description = String(payload?.description ?? '').trim()
    const type = String(payload?.type ?? '').trim()
    const priority = String(payload?.priority ?? '').trim()
    const epic = String(payload?.epic ?? '').trim()

    if (!wantedTracker) return send(res, 400, { error: 'tracker is missing' })
    if (!wantedProject) return send(res, 400, { error: 'project is missing' })
    if (!title) return send(res, 400, { error: 'title is missing' })
    if (title.length > 255) return send(res, 400, { error: 'title is longer than 255 characters' })
    if (description.length > 4000) return send(res, 400, { error: 'description is longer than 4000 characters' })
    if (epic.length > 255) return send(res, 400, { error: 'epic is longer than 255 characters' })

    let bundle
    try {
      bundle = await loadProjects(projectsFile)
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'projects.yml could not be read' })
    }
    const { canonical, projects, trackers } = bundle
    const tracker = trackers.find((entry) => entry.id === wantedTracker)
    if (!tracker) return send(res, 404, { error: `unknown tracker: ${wantedTracker}` })
    const project = projects.find((entry) => entry.id === wantedProject)
    if (!project) return send(res, 404, { error: `unknown project: ${wantedProject}` })
    const reader = readerFor(tracker, project)

    const types = canonical.types.filter((name) => name in (reader.map?.types ?? {}))
    const priorities = canonical.priorities.filter((name) => name in (reader.map?.priorities ?? {}))
    if (!type) return send(res, 400, { error: 'type is missing' })
    if (!types.includes(type)) return send(res, 400, { error: `unknown type: ${type}` })
    if (!priority) return send(res, 400, { error: 'priority is missing' })
    if (!priorities.includes(priority)) return send(res, 400, { error: `unknown priority: ${priority}` })
    if (reader.tracker === 'github' && epic && !/^\d+$/.test(epic)) {
      return send(res, 400, { error: 'epic must be a GitHub milestone number' })
    }

    let result
    try {
      result = await createTrackerMission(reader, {
        title,
        description,
        type,
        priority,
        epic: epic || null,
      }, { fetchImpl, now })
    } catch (error) {
      // The tracker refused: that is upstream, not a bad request from the panel.
      return send(res, 502, { error: error instanceof Error ? error.message : 'tracker write failed' })
    }

    // The tracker answers with its own shape: GitHub renders a `mission`, Jira
    // renders the issue key alone. The declaration needs the key, whatever the
    // adapter returns.
    const createdKey = result?.mission?.key ?? result?.key ?? null

    // The issue exists: a local write that fails must answer 201 with a warning,
    // never 5xx — the form would replay and duplicate the issue. The declaration
    // is repairable from the mission folder.
    let warning = null
    try {
      if (!createdKey) throw new Error('the tracker named no mission key')
      await saveDeclaration(branchesDir, { key: createdKey, project: project.id })
    } catch (error) {
      warning = `the issue was created, but its mission folder could not be written: ${error instanceof Error ? error.message : String(error)}`
    }

    // The tracker answers with its own identity; the panel works on the board
    // and the repository the request named.
    const mission = {
      ...(result.mission ?? {}),
      key: createdKey,
      project: project.id,
      projectName: project.name,
      repo: project.repo ?? null,
      translations: project.translations ?? null,
      trackerId: tracker.id,
      trackerName: tracker.name,
    }
    return send(res, 201, { ...result, mission, project: project.id, ...(warning ? { warning } : {}) })
  }

  // The local close: the only gesture that deletes a branch. It reads the proof
  // on the tracker, then acts on the machine in one shot — the panel sends only
  // a key, and this route owns every decision and every refused sentence.
  const localClose = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const key = String(payload?.key ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })

    try {
      const { projects, trackers } = await loadProjects(projectsFile)
      const { tracker, project } = resolveMissionProject({ projects, trackers }, key, payload?.project)
      const reader = readerFor(tracker, project)
      const bundle = await loadBranches(branchesDir, { projects })
      const declaration = declarationFor(bundle, key, project.id)
      if (!declaration?.folder) return send(res, 409, { error: `no mission folder for ${key}` })

      // Every declared pair is proven: a split mission only closes when each
      // of its pull requests is merged into its own base and has reached the
      // mission's base. A legacy declaration is the same list of one.
      const declared = Array.isArray(declaration.branches) && declaration.branches.length > 0
        ? declaration.branches
        : [{ branch: declaration.branch, base: declaration.base }]
      const pairs = []
      for (const pair of declared) {
        let proof
        try {
          proof = await readProof({
            project: reader,
            key,
            branch: pair.branch,
            base: pair.base,
            fetchImpl,
            githubToken: config?.githubToken,
          })
        } catch (error) {
          // A split mission's refusal names the pair it comes from: "pull
          // request #8 is not merged" alone leaves the requester guessing
          // which of the stacked PRs to open.
          if (declared.length < 2) throw error
          const message = error instanceof Error ? error.message : String(error)
          throw new LocalCloseError(`${key} (${pair.branch} sur ${pair.base}): ${message}`, error?.status ?? 409)
        }
        pairs.push({ branch: pair.branch, base: pair.base, proof })
      }
      const journalPath = fileURLToPath(new URL(`./${declaration.folder}/${JOURNAL_FILE}`, branchesDir))
      const plan = await planClose({
        key,
        repo: project.repo,
        branch: pairs[0].branch,
        base: pairs[0].base,
        proof: pairs[0].proof,
        pairs,
        run: runGit,
        journalPath,
      })
      const result = await closeLocal(plan, { run: runGit })
      return send(res, 200, { ...result, project: project.id })
    } catch (error) {
      // A refusal is a message for the panel (400/404/409), an upstream failure is not.
      if (error instanceof HttpError) return send(res, error.status, { error: error.message })
      if (error instanceof LocalCloseError) return send(res, error.status, { error: error.message })
      return send(res, 502, { error: error instanceof Error ? error.message : 'local close failed' })
    }
  }

  // Archiving: the folder of a done mission leaves the panel's reading path.
  // The panel sends only a key; this route reads the declaration, re-reads the
  // tracker's answer (the proof of `done`), then moves the folder itself.
  const archive = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const key = String(payload?.key ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })

    try {
      const { projects, trackers } = await loadProjects(projectsFile)
      const { tracker, project } = resolveMissionProject({ projects, trackers }, key, payload?.project)
      const reader = readerFor(tracker, project)
      const bundle = await loadBranches(branchesDir, { projects })
      const declaration = declarationFor(bundle, key, project.id)
      if (!declaration?.folder) return send(res, 409, { error: `no mission folder for ${key}` })

      // Archiving is a gesture of Done: a stale row, a label moved by hand or a
      // closed issue only the folder declares must not archive open work. The
      // read is fresh — the TTL cache could still say `done` from before — and
      // it asks the tracker once, with the key this project declares.
      const { missions, errors } = await readTrackers([tracker], projects, {
        refresh: true,
        fetchImpl,
        declaredKeys: new Set([key]),
        declarations: new Map([[key, [project.id]]]),
        scope: 'done',
      })
      // This proof read is a mono-key answer, and `listAll` memoizes it before
      // filtering keys: keeping it would leave Done with this row alone after a
      // refusal (or empty after a non-done answer). Drop it on every path.
      forget(reader, 'done')
      if (errors.length > 0) return send(res, 502, { error: errors[0].message })
      const mission = missions.find((entry) => entry.key === key && entry.state === 'done')
      if (!mission) return send(res, 409, { error: `${key} is not done` })

      const result = await archiveMission({ root: branchesDir, key, folder: declaration.folder, mission })
      // A Done read may have memoized the pre-move list between the proof read
      // and the rename: drop it again so the panel never serves the moved row.
      forget(reader, 'done')
      return send(res, 200, { archived: result.archived, folder: result.folder, project: project.id })
    } catch (error) {
      // A refusal is a message for the panel (its ArchiveError status); a failure
      // of the machine itself (permission, volume) is not an upstream answer.
      if (error instanceof HttpError) return send(res, error.status, { error: error.message })
      if (error instanceof ArchiveError) return send(res, error.status, { error: error.message })
      return send(res, 500, { error: error instanceof Error ? error.message : 'archive failed' })
    }
  }

  // The batch archive: one gesture for the missions the Done list shows. The
  // panel sends the keys it rendered — nothing else; this route proves each key
  // `done` with one fresh tracker read per project, then archives folder by
  // folder. A per-key refusal is data for the panel, not a failed request.
  const archiveBatch = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    if (!Array.isArray(payload?.keys)) {
      return send(res, 400, { error: 'keys must be a list' })
    }
    const keys = [...new Set(payload.keys.map((key) => String(key ?? '').trim()).filter(Boolean))]
    if (keys.length === 0) return send(res, 400, { error: 'keys is empty' })

    try {
      const { projects, trackers } = await loadProjects(projectsFile)
      const bundle = await loadBranches(branchesDir, { projects })

      // A key the machine cannot declare is refused for that key: one bad line
      // must not turn the whole selection into a failed request.
      const refused = []
      const folders = new Map()
      const byTracker = new Map()
      const wanted = payload?.projects && typeof payload.projects === 'object' ? payload.projects : {}
      for (const key of keys) {
        let resolved
        try {
          resolved = resolveMissionProject({ projects, trackers }, key, wanted[key] ?? '')
        } catch (error) {
          if (!(error instanceof HttpError)) throw error
          refused.push({ key, error: error.message })
          continue
        }
        const { tracker, project } = resolved
        const declaration = declarationFor(bundle, key, project.id)
        if (!declaration?.folder) {
          refused.push({ key, error: `no mission folder for ${key}` })
          continue
        }
        folders.set(key, declaration.folder)
        if (!byTracker.has(tracker.id)) {
          byTracker.set(tracker.id, { tracker, reader: readerFor(tracker, project), keys: new Set(), declarations: new Map() })
        }
        const group = byTracker.get(tracker.id)
        group.keys.add(key)
        group.declarations.set(key, [project.id])
      }

      // One proof read per tracker, fresh: the TTL cache could still say `done`
      // from before. A tracker whose closed read fails proves nothing, so the
      // gesture is refused as a whole rather than archiving a subset nobody can
      // vouch for — nothing has moved yet.
      const proven = new Map()
      for (const { tracker, reader, keys: trackerKeys, declarations } of byTracker.values()) {
        const { missions, errors } = await readTrackers([tracker], projects, {
          refresh: true,
          fetchImpl,
          declaredKeys: trackerKeys,
          declarations,
          scope: 'done',
        })
        forget(reader, 'done')
        if (errors.length > 0) return send(res, 502, { error: errors[0].message })
        for (const mission of missions) proven.set(mission.key, mission)
      }

      const entries = []
      for (const key of keys) {
        if (refused.some((entry) => entry.key === key)) continue
        const mission = proven.get(key)
        if (mission?.state !== 'done') {
          refused.push({ key, error: `${key} is not done` })
          continue
        }
        entries.push({ key, folder: folders.get(key), mission })
      }

      const result = await archiveMany({ root: branchesDir, entries })
      // A Done read may have memoized the pre-move list between the proof read
      // and the renames: drop it once more so the panel never serves a moved row.
      for (const { reader } of byTracker.values()) forget(reader, 'done')

      // Refusals are reported in the order the panel sent the keys: the panel
      // reads them back line by line, not by phase of the host's checks.
      const rank = new Map(keys.map((key, position) => [key, position]))
      const refusals = [...refused, ...result.refused].sort(
        (left, right) => (rank.get(left.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.key) ?? Number.MAX_SAFE_INTEGER),
      )
      return send(res, 200, { archived: result.archived, refused: refusals })
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message })
      if (error instanceof ArchiveError) return send(res, error.status, { error: error.message })
      return send(res, 500, { error: error instanceof Error ? error.message : 'archive failed' })
    }
  }

  // The Tolgee import: the panel sends a key; this route reads the mission's
  // branch, the project's locales and the XLIFF it writes. Tolgee is never
  // called — the file is the deliverable, the import stays the requester's act.
  const tolgee = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }

    const key = String(payload?.key ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })

    try {
      const { projects, trackers } = await loadProjects(projectsFile)
      const { tracker, project } = resolveMissionProject({ projects, trackers }, key, payload?.project)
      if (!project.translations) return send(res, 409, { error: `${project.id} declares no translations` })

      const bundle = await loadBranches(branchesDir, { projects })
      const declaration = declarationFor(bundle, key, project.id)
      if (!declaration?.folder) return send(res, 409, { error: `no mission folder for ${key}` })

      const plan = await planImport({
        repo: project.repo,
        base: declaration.base,
        branch: declaration.branch,
        pairs: declaration.branches?.length ? declaration.branches : null,
        translations: project.translations,
        run: runGit,
      })
      if (plan.keys.length === 0) {
        return send(res, 200, {
          project: project.id,
          file: null,
          keys: [],
          untranslated: plan.untranslated,
          warnings: plan.warnings,
        })
      }

      const content = buildXliff({ entries: plan.keys, original: key })
      const path = fileURLToPath(new URL(`./${declaration.folder}/${IMPORT_FILE}`, branchesDir))
      await writeAtomically(path, content)
      return send(res, 200, {
        project: project.id,
        file: `missions/${declaration.folder}/${IMPORT_FILE}`,
        keys: plan.keys,
        untranslated: plan.untranslated,
        warnings: plan.warnings,
      })
    } catch (error) {
      // A missing branch, an empty diff or an unreadable locale is a refusal
      // the panel must say out loud; anything else is the machine failing.
      if (error instanceof HttpError) return send(res, error.status, { error: error.message })
      if (error instanceof TolgeeError) return send(res, error.status, { error: error.message })
      return send(res, 500, { error: error instanceof Error ? error.message : 'tolgee import failed' })
    }
  }

  // The journal sits next to `mission.yml`, in the folder the declaration
  // already names. The route reads it; writing it is the session's job.
  const journal = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const key = (url.searchParams.get('key') ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })
    const wanted = (url.searchParams.get('project') ?? '').trim()
    try {
      // The journal lives in the declared folder: reading it needs no board.
      const bundle = await loadDeclarations()
      if (!wanted && bundle.duplicates?.has(key)) return send(res, 400, { error: 'project is required' })
      const folder = declarationFor(bundle, key, wanted)?.folder ?? null
      const { exists, source, mtimeMs } = await readJournal(branchesDir, folder)
      return send(res, 200, {
        key,
        folder,
        path: folder ? `${folder}/${JOURNAL_FILE}` : null,
        exists,
        source,
        mtimeMs,
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The checklist also sits next to `mission.yml`, in the folder the
  // declaration names. The route reads it; the session ticks it in the file.
  const checklist = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const key = (url.searchParams.get('key') ?? '').trim()
    if (!key) return send(res, 400, { error: 'key is missing' })
    const wanted = (url.searchParams.get('project') ?? '').trim()
    try {
      const bundle = await loadDeclarations()
      if (!wanted && bundle.duplicates?.has(key)) return send(res, 400, { error: 'project is required' })
      const folder = declarationFor(bundle, key, wanted)?.folder ?? null
      const { exists, source, mtimeMs } = await readChecklist(branchesDir, folder)
      return send(res, 200, {
        key,
        folder,
        path: folder ? `${folder}/${CHECKLIST_FILE}` : null,
        exists,
        source,
        mtimeMs,
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The outline needs each declared mission's checklist without opening its
  // drawer: this index reads them all once and keeps them for a short while,
  // so a keystroke never touches the disk and opening the panel pays a single
  // read. `?refresh=1` is the gesture that pays again.
  let checklistIndexCache = null
  const CHECKLIST_INDEX_TTL_MS = 30000
  const checklistIndex = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const refresh = url.searchParams.get('refresh') === '1'
    const now = Date.now()
    if (!refresh && checklistIndexCache !== null && now - checklistIndexCache.at < CHECKLIST_INDEX_TTL_MS) {
      return send(res, 200, checklistIndexCache.value)
    }
    try {
      const { byProject, errors } = await loadDeclarations()
      const missions = []
      for (const entry of byProject.values()) {
        const key = entry.key
        const { exists, source, mtimeMs } = await readChecklist(branchesDir, entry.folder)
        const { blocks, counts } = parseChecklist(source)
        // The outline shows the items, and the heading that groups them: a
        // checklist's structure is part of what it says. Bullets and notes are
        // left to the drawer.
        const lines = blocks
          .filter((block) => block.type === 'item' || block.type === 'heading')
          .map((block) => block.type === 'heading'
            ? { text: block.text, state: null, heading: true }
            : { text: block.text, state: block.state })
        missions.push({ key, folder: entry.folder, exists, mtimeMs, counts, lines })
      }
      missions.sort((left, right) => left.key.localeCompare(right.key) || String(left.folder).localeCompare(String(right.folder)))
      const value = { missions, errors }
      checklistIndexCache = { at: now, value }
      return send(res, 200, value)
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The tally of the panel's own gestures: the Usage tab reads it, and one
  // gesture writes it. The file is local to this machine (`usagePath`), so a
  // POST never touches git, a tracker or the workspace — and a GET never
  // creates the file, because opening a tab is not using the panel.
  const usage = async (req, res) => {
    const method = req.method ?? 'GET'
    const file = usagePath({ usageFile: config?.usageFile, dshHome: config?.dshHome })
    if (method === 'GET') {
      try {
        return send(res, 200, await readUsage(file))
      } catch (error) {
        return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
      }
    }
    if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })
    let gesture
    try {
      gesture = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }
    try {
      return send(res, 200, await recordUsage(file, gesture))
    } catch (error) {
      return send(res, error?.status ?? 500, { error: error instanceof Error ? error.message : 'write failed' })
    }
  }

  // The parcours itself: every model of the directory, each one a graph of
  // gestures or of canonical states. The panel lists them, reads them, edits
  // them, and writes a model back only if it validates.
  /** Whether a file exists, without throwing: the resolver asks twice. */
  const exists = async (url) => {
    try {
      await access(url)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Where a workflow lives: the versioned directory first, then the local one.
   * One key, one workflow — the caller never names the directory, it finds it.
   */
  const workflowDir = async (workflow) => {
    if (modelsDir && await exists(new URL(`./${workflow}.yml`, modelsDir))) return modelsDir
    if (localModelsDir && await exists(new URL(`./${workflow}.yml`, localModelsDir))) return localModelsDir
    return modelsDir
  }

  const workflowList = async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      const canonical = await loadCanonical(projectsFile)
      const { workflows } = await loadWorkflows(modelsDir, { states: canonical.states })
      const { workflows: local } = localModelsDir
        ? await loadWorkflows(localModelsDir, { states: canonical.states })
        : { workflows: [] }
      // Versioned models keep their order; local ones follow, sorted by title:
      // a workflow named like a method step stays a local, not a fifth step.
      local.sort((a, b) => String(a.title).localeCompare(String(b.title), 'fr') || String(a.workflow).localeCompare(String(b.workflow)))
      return send(res, 200, {
        workflows: [...workflows, ...local].map(({ text, ...entry }) => entry),
        writers: WRITERS,
        states: canonical.states,
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // Create one workflow: the model and the document stub, both under
  // `workflows/`. An existing file is never overwritten — the keys of the
  // folder are the namespace, and a key is free only when its file is absent.
  const workflowCreate = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : 'invalid request body' })
    }
    try {
      const { canonical } = await loadProjects(projectsFile)
      const created = await createWorkflow(modelsDir, body, { states: canonical.states })
      if (created.errors?.length) return send(res, 400, { error: 'workflow invalid', errors: created.errors })
      return send(res, 201, {
        workflow: created.entry.workflow,
        file: created.entry.file,
        document: created.entry.document,
        local: created.entry.local === true,
        entry: created.entry,
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // One model: read as text (the source of truth on disk), or written back
  // after a full validation. A refused model is never written: the file and the
  // panel cannot disagree.
  const workflowModel = async (req, res, url) => {
    const method = req.method ?? 'GET'
    if (method === 'GET') {
      const workflow = (url.searchParams.get('workflow') ?? '').trim()
      if (!workflow) return send(res, 400, { error: 'workflow is missing' })
      if (!isWorkflowKey(workflow)) return send(res, 400, { error: `unknown workflow: ${workflow}` })
      try {
        const { canonical } = await loadProjects(projectsFile)
        const dir = await workflowDir(workflow)
        const entry = await readWorkflow(dir, workflow, { states: canonical.states })
        if (entry.text === null) return send(res, 400, { error: `unknown workflow: ${workflow}` })
        return send(res, 200, {
          workflow,
          file: entry.file,
          local: entry.local,
          text: entry.text,
          headings: entry.headings,
          errors: entry.errors,
          orphanSections: entry.orphanSections,
          entry,
        })
      } catch (error) {
        return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
      }
    }

    if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : 'invalid request body' })
    }
    const workflow = String(body.workflow ?? '').trim()
    if (!isWorkflowKey(workflow)) return send(res, 400, { error: `unknown workflow: ${workflow || '(missing)'}` })
    if (!body.model || typeof body.model !== 'object' || Array.isArray(body.model)) {
      return send(res, 400, { error: 'model is missing' })
    }

    try {
      const { canonical } = await loadProjects(projectsFile)
      const source = await workflowDir(workflow)
      const saved = await saveWorkflow(source, workflow, body.model, {
        states: canonical.states,
        local: body.local === undefined ? undefined : body.local === true,
      })
      if (saved.errors?.length) {
        return send(res, saved.conflict ? 409 : 400, {
          error: saved.conflict ? 'workflow conflict' : 'model invalid',
          workflow,
          errors: saved.errors,
          orphanSections: saved.orphanSections ?? [],
        })
      }
      const dir = await workflowDir(workflow)
      const entry = await readWorkflow(dir, workflow, { states: canonical.states })
      return send(res, 200, {
        workflow,
        file: `${saved.local ? LOCAL_MODEL_DIR : MODEL_DIR}/${workflow}.yml`,
        local: saved.local === true,
        model: saved.model,
        entry,
        errors: [],
        orphanSections: saved.orphanSections ?? [],
        headings: saved.headings ?? [],
      })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The five playbook pages: the list shows them, one route reads a page as
  // raw markdown, the same route writes it back only after the CLI's own rules
  // pass. The index is not a page — the route only serves what the list names,
  // so no request can reach `playbook/README.md`, and nothing here creates,
  // removes or renames a file.
  const playbookList = async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      return send(res, 200, { pages: await listPlaybooks(playbookDir) })
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  const playbookPage = async (req, res, url) => {
    const method = req.method ?? 'GET'
    if (method === 'GET') {
      try {
        return send(res, 200, await readPlaybook(playbookDir, url.searchParams.get('page') ?? ''))
      } catch (error) {
        if (error instanceof PlaybookError) return send(res, error.status, { error: error.message })
        return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
      }
    }
    if (method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request body' })
    }
    try {
      return send(res, 200, await savePlaybook(playbookDir, body))
    } catch (error) {
      if (error instanceof PlaybookError) {
        const payload = { error: error.message }
        if (error.errors?.length) payload.errors = error.errors
        return send(res, error.status, payload)
      }
      return send(res, 500, { error: error instanceof Error ? error.message : 'internal error' })
    }
  }

  // The repositories of the workspace root: a read-only scan of the direct
  // children that carry `.git`. The root is the host's, never the request's —
  // a `?root=` is ignored, so the panel cannot be told to read another tree.
  /** The project repository paths, expanded and resolved, keyed by absolute path. */
  const declaredRepositories = async () => {
    try {
      const { projects } = await loadProjects(projectsFile)
      return new Map(projects.map((project) => {
        const path = String(project.repo ?? '')
        const absolute = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
        return [resolve(absolute), project.id]
      }))
    } catch {
      // A missing or broken declaration is already reported by the list: the
      // repository scan still shows the machine, just without the marks.
      return new Map()
    }
  }

  const markDeclared = (repositories, declared) => repositories.map((row) => ({
    ...row,
    declared: declared.get(resolve(row.path)) ?? null,
  }))

  const repositories = async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      const [scan, declared] = await Promise.all([
        listRepositories(workspaceRoot, { run: runGit }),
        declaredRepositories(),
      ])
      return send(res, 200, { ...scan, repositories: markDeclared(scan.repositories, declared) })
    } catch (error) {
      // An unreadable root is this machine's state, not a bad request.
      return send(res, 500, { error: `${workspaceRoot}: ${error instanceof Error ? error.message : 'scan failed'}` })
    }
  }

  // The dashboard's digest of the root: the rows of the scan above, read
  // through a five-minute memory so a minute of ticks costs one scan. The
  // panel's tick and its opening read the cache; `?refresh=1` — the section's
  // Retry — pays a new scan. The root is the host's, never the request's.
  const repositoriesSummary = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const refresh = url.searchParams.get('refresh') === '1'
    try {
      const [summary, declared] = await Promise.all([
        summarizeRepositories(workspaceRoot, { run: runGit, refresh }),
        declaredRepositories(),
      ])
      return send(res, 200, { ...summary, repositories: markDeclared(summary.repositories, declared) })
    } catch (error) {
      // An unreadable root is this machine's state, not a bad request.
      return send(res, 500, { error: `${workspaceRoot}: ${error instanceof Error ? error.message : 'scan failed'}` })
    }
  }

  // How many repositories the root holds, without the scan: the tab badge
  // reads it at mount and the scan costs two git calls per entry. The root is
  // the host's, never the request's — a `?root=` is ignored.
  const repositoriesCount = async (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    try {
      return send(res, 200, { count: await countRepositories(workspaceRoot) })
    } catch (error) {
      // An unreadable root is this machine's state, not a bad request.
      return send(res, 500, { error: `${workspaceRoot}: ${error instanceof Error ? error.message : 'count failed'}` })
    }
  }

  // One repository: its remote, its upstream and its working tree. The name
  // is checked by the module before anything runs, so a refused name never
  // reaches git and never reads outside the root.
  const repositoryDetail = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const name = (url.searchParams.get('name') ?? '').trim()
    try {
      return send(res, 200, await readRepository(workspaceRoot, name, { run: runGit }))
    } catch (error) {
      return send(res, error?.status ?? 500, { error: error instanceof Error ? error.message : 'read failed' })
    }
  }

  // One page of a branch history: `?name=&branch=&skip=`. A refused branch is
  // a 400 from the module, a git refusal a 502 with git's own sentence.
  const repositoryHistory = async (req, res, url) => {
    if ((req.method ?? 'GET') !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    const name = (url.searchParams.get('name') ?? '').trim()
    const branch = (url.searchParams.get('branch') ?? '').trim() || null
    const skip = url.searchParams.get('skip')
    try {
      return send(res, 200, await readHistory(workspaceRoot, name, { branch, skip, run: runGit }))
    } catch (error) {
      return send(res, error?.status ?? 500, { error: error instanceof Error ? error.message : 'read failed' })
    }
  }

  // The one gesture of this module that writes: bring a worktree's branch back
  // into its main checkout. The name is checked by the module before git sees
  // it, and a refusal of the machine's state answers 409 with its reason.
  // One write at a time: two adoptions of the same main checkout would race
  // for its index lock and could each pass the checks the other invalidated.
  let adoptQueue = Promise.resolve()
  const repositoryAdopt = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    // The second answer to the ignored-entries question: the folder goes with
    // them. Anything else is false, so a malformed body cannot consent.
    const acceptIgnored = body?.acceptIgnored === true
    const queued = adoptQueue.then(() => adoptWorktree(workspaceRoot, name, { run: runGit, acceptIgnored }))
    adoptQueue = queued.then(() => {}, () => {})
    try {
      return send(res, 200, await queued)
    } catch (error) {
      return send(res, error?.status ?? 500, {
        error: error instanceof Error ? error.message : 'switch failed',
        ...(error?.side ? { side: error.side } : {}),
        ...(error?.ignored ? { ignored: true } : {}),
        ...(Array.isArray(error?.files) ? { files: error.files } : {}),
      })
    }
  }

  // The other write: delete a worktree's folder, keep its branch. No queue —
  // each worktree has its own index, and the module reads the state before it
  // writes, so two rows cannot invalidate each other's checks.
  const repositoryRemove = async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      const headers = error?.tooLarge ? { connection: 'close' } : {}
      return send(res, error?.status ?? 400, { error: error instanceof Error ? error.message : 'invalid request' }, headers)
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    // The second answer to the ignored-entries question: the folder goes with
    // them. Anything else is false, so a malformed body cannot consent.
    const acceptIgnored = body?.acceptIgnored === true
    try {
      return send(res, 200, await removeWorktree(workspaceRoot, name, { run: runGit, acceptIgnored }))
    } catch (error) {
      return send(res, error?.status ?? 500, {
        error: error instanceof Error ? error.message : 'remove failed',
        ...(error?.side ? { side: error.side } : {}),
        ...(error?.ignored ? { ignored: true } : {}),
        ...(Array.isArray(error?.files) ? { files: error.files } : {}),
      })
    }
  }

  const handler = async (req, res) => {
    if (!isLocalRequest(req)) return send(res, 403, { error: 'origin not allowed' })

    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return send(res, 400, { error: 'invalid request' })
    }

    if (url.pathname === '/missions/api/list') return list(req, res, url)
    if (url.pathname === '/missions/api/create/epics') return createEpics(req, res, url)
    if (url.pathname === '/missions/api/create') {
      return (req.method ?? 'GET') === 'POST' ? createMission(req, res) : createOptions(req, res)
    }
    if (url.pathname === '/missions/api/done/count') return doneCount(req, res)
    if (url.pathname === '/missions/api/branches') return declare(req, res)
    if (url.pathname === '/missions/api/pin') return pin(req, res)
    if (url.pathname === '/missions/api/blocked') return blocked(req, res)
    if (url.pathname === '/missions/api/priority') return priority(req, res)
    if (url.pathname === '/missions/api/points') return points(req, res)
    if (url.pathname === '/missions/api/local-close') return localClose(req, res)
    if (url.pathname === '/missions/api/archive') return archive(req, res)
    if (url.pathname === '/missions/api/archive-batch') return archiveBatch(req, res)
    if (url.pathname === '/missions/api/tolgee') return tolgee(req, res)
    if (url.pathname === '/missions/api/journal') return journal(req, res, url)
    if (url.pathname === '/missions/api/checklist') return checklist(req, res, url)
    if (url.pathname === '/missions/api/checklist-index') return checklistIndex(req, res, url)
    if (url.pathname === '/missions/api/usage') return usage(req, res)
    if (url.pathname === '/missions/api/workflows') {
      return (req.method ?? 'GET') === 'POST' ? workflowCreate(req, res) : workflowList(req, res)
    }
    if (url.pathname === '/missions/api/workflows/model') return workflowModel(req, res, url)
    if (url.pathname === '/missions/api/playbooks') return playbookList(req, res)
    if (url.pathname === '/missions/api/playbooks/page') return playbookPage(req, res, url)
    if (url.pathname === '/missions/api/repositories') return repositories(req, res)
    if (url.pathname === '/missions/api/repositories/summary') return repositoriesSummary(req, res, url)
    if (url.pathname === '/missions/api/repositories/count') return repositoriesCount(req, res)
    if (url.pathname === '/missions/api/repositories/detail') return repositoryDetail(req, res, url)
    if (url.pathname === '/missions/api/repositories/commits') return repositoryHistory(req, res, url)
    if (url.pathname === '/missions/api/repositories/adopt') return repositoryAdopt(req, res)
    if (url.pathname === '/missions/api/repositories/remove') return repositoryRemove(req, res)
    return send(res, 404, { error: 'unknown route' })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/missions/api', handler }))

  // The two roots every writing route derives from, returned so a test can
  // check them without a writable fixture: the routes themselves need no
  // project to know where the mission folders live.
  return { projectsFile, branchesDir }
}

/**
 * Workspace record for the code root, when the registry is reachable.
 *
 * The registry is a host service: panels cannot see it, so the id is resolved
 * here and handed to the client with the list.
 */
async function resolveWorkspaceId(ctx, root) {
  // Preferred: the host registry, when this plugin is allowed to see it.
  try {
    const registry = ctx.workspaceRegistry
    if (registry && typeof registry.resolveByPath === 'function') {
      const record = await registry.resolveByPath(root)
      if (record?.id) return record.id
    }
  } catch {
    // fall through to the on-disk registry
  }

  // Fallback: the registry file the app keeps on disk, read-only.
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    const store = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    return findWorkspaceId(store, root, homedir())
  } catch {
    return null
  }
}

function send(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(value))
}

/** Read a small JSON request body; a huge or malformed body is a 400. */
async function readJson(req) {
  const limit = 16 * 1024
  const refuse = () => Object.assign(new Error('request body too large'), { status: 400, tooLarge: true })
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    // Drain instead of destroying: the 400 has to reach the client first.
    req.resume?.()
    throw refuse()
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      req.resume?.()
      throw refuse()
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) throw Object.assign(new Error('empty request body'), { status: 400 })
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

/** Only local requests are served: the panel runs on the same machine. */
function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const local = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!local) return false
  const origin = req.headers?.origin
  if (!origin) return true
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}
