# Revue

Décider si le changement entre. La revue juge le diff contre le cadrage, pas
contre les goûts du relecteur.

## Ce qu'on relit

1. **Les critères d'acceptation**, un par un, contre ce que la PR démontre. Un
   critère sans preuve est un critère non tenu.
2. **Le diff**, pour ce qu'il fait et non pour ce qu'il annonce : portée réelle,
   effets de bord, cas d'erreur.
3. **Le périmètre** : ce qui est dans la PR était dans le cadrage.
4. **Les tests** : ils passent, et ils couvrent le comportement ajouté.

## Décisions possibles

- **Approuvée** — la PR part en clôture.
- **À reprendre** — commentaires précis, chacun rattaché à un critère ou à un
  défaut nommé ; la mission reste « en revue ».
- **Retour au cadrage** — le désaccord porte sur le périmètre ou l'objectif, pas
  sur le code.

## Condition de sortie

- [ ] Chaque critère d'acceptation est coché ou explicitement refusé.
- [ ] Chaque refus nomme ce qui manque et où.
- [ ] La décision est écrite dans le ticket (approuvée / à reprendre / retour
      cadrage), avec la date.

## Ce qui n'est pas un motif de refus

- Un style différent de celui du relecteur, s'il respecte le style du projet.
- Une amélioration possible hors périmètre : elle devient un ticket.
- Une préférence non écrite dans le cadrage.

## Sur le tracker

| Geste | Jira | GitHub |
|---|---|---|
| Demander des changements | statut In Review + commentaires | review « Request changes » |
| Approuver | statut `Ready for prod` + commentaire d'approbation | review « Approve » + label `ready-for-prod` |
| Renvoyer au cadrage | statut To Do + commentaire de motif | label `to-refine`, issue rouverte si besoin |
