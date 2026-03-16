# Circles Groups Manager

Circles Groups Manager is a small Vite-based miniapp for creating and operating Circles groups on Gnosis Chain. It is built to run inside the Circles host app, where a connected wallet can create new groups, manage group metadata, maintain membership, administer the owner Safe, and move group tokens.

## What it does

- Lists groups owned directly by the connected wallet or by owner Safes the wallet controls
- Creates a new group, including:
  - an owner Safe for the connected wallet
  - a group Safe owned by that owner Safe
  - the BaseGroup contract deployment with profile metadata
- Opens an existing group and shows:
  - group addresses and ownership details
  - treasury collateral
  - token holders
  - total supply
- Updates group profile metadata:
  - description
  - preview image
  - external link
- Manages group admins:
  - review current owner Safe owners
  - add a new owner to the owner Safe
  - change the group owner Safe address
- Manages group members by adding or removing trust relationships
- Mints group tokens by routing collateral to the mint handler
- Sends group tokens using Circles max-flow routing

## Getting started

### Requirements

- Node.js 18+ recommended
- npm
- access to a Circles host environment for end-to-end testing

### Install

```bash
npm install
```

### Run locally

```bash
npm run dev
```

The Vite dev server runs on `http://localhost:5184`.

For a realistic test, load that URL through the Circles miniapp host so wallet connection and transaction submission are available.

### Production build

```bash
npm run build
```

Preview the build with:

```bash
npm run preview
```

## Main workflows

### Create a group

Creating a group batches several steps into one approval flow:

1. Upload profile metadata
2. Predict and deploy an owner Safe for the connected wallet
3. Predict and deploy a group Safe owned by the owner Safe
4. Create the BaseGroup contract with the supplied name, symbol, and metadata

The UI validates:

- group name is required and limited to 19 characters
- ticker must be 2 to 8 uppercase letters or digits
- description is required

### Edit group details

Once a group is open, the app can update:

- markdown description
- preview image
- optional external link

Profile metadata is stored via the Circles profile service and then written back to the group contract metadata digest.

### Manage admins

The app supports two separate admin actions:

- adding a new owner to the current owner Safe
- updating the group contract so it points at a different owner Safe

### Manage members

Members are managed through group trust:

- add member: trust the selected avatar
- remove member: revoke trust from the selected avatar

### Treasury and token actions

The group details view loads:

- treasury collateral balances
- token holders
- total supply
- the current max mintable amount

Token actions support:

- minting by routing collateral to the group mint handler
- sending the group token through Circles max-flow routing

## Project structure

```text
.
├── circlesClient.js   # Thin wrapper around Circles SDK clients and group avatar helpers
├── index.html         # App shell and management panels
├── main.js            # UI state, wallet lifecycle, and all group workflows
├── style.css          # Application styling
├── vite.config.js     # Vite config and chunk splitting
└── dist/              # Build output
```
