//! String tag → node membership, used for O(members) bulk invalidation.

use std::collections::{HashMap, HashSet};

/// Interned tags plus the set of live node slots belonging to each tag.
///
/// Tag ids are monotonically increasing and **never reused**. When the last member of a tag is
/// removed the tag is forgotten entirely, so the registry cannot grow without bound while
/// still being safe against a stale id aliasing a newer tag.
#[derive(Debug, Default)]
pub(crate) struct TagIndex {
    /// name → id, for fast lookup when the caller only has a string.
    ids: HashMap<String, u32>,
    /// id → tag data (keeps the name so it can be forgotten).
    tags: HashMap<u32, Tag>,
    next_id: u32,
}

#[derive(Debug)]
struct Tag {
    name: String,
    members: HashSet<usize>,
}

impl TagIndex {
    /// Returns the id for `name`, creating the tag if it is new.
    fn intern(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.ids.get(name) {
            return id;
        }
        let id = self.next_id;
        // u32 ids are never reused; wrapping would alias unrelated tags.
        self.next_id = self
            .next_id
            .checked_add(1)
            .expect("blaze-cache: tag id space exhausted");
        self.ids.insert(name.to_owned(), id);
        self.tags.insert(
            id,
            Tag {
                name: name.to_owned(),
                members: HashSet::new(),
            },
        );
        id
    }

    /// Interns every name, de-duplicating within the batch, and returns the ids.
    pub(crate) fn intern_all<'a, I>(&mut self, names: I) -> Vec<u32>
    where
        I: IntoIterator<Item = &'a str>,
    {
        let mut ids = Vec::new();
        for name in names {
            let id = self.intern(name);
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids
    }

    /// Marks `node` as a member of `id`.
    ///
    /// The id was interned moments ago and ids are never reused, so finding no tag here
    /// means the caller's tag list has silently diverged from the index — which is exactly
    /// how a live entry ends up unreachable by [`invalidate_tags`](crate::Cache::invalidate_tags).
    /// That must never pass unnoticed.
    pub(crate) fn attach(&mut self, id: u32, node: usize) {
        let Some(tag) = self.tags.get_mut(&id) else {
            debug_assert!(
                false,
                "blaze-cache: attaching node to forgotten tag id {id} — the tag index lost a member"
            );
            return;
        };
        tag.members.insert(node);
    }

    /// Removes `node` from `id`, forgetting the tag once it has no members left.
    pub(crate) fn detach(&mut self, id: u32, node: usize) {
        let empty = match self.tags.get_mut(&id) {
            Some(tag) => {
                tag.members.remove(&node);
                tag.members.is_empty()
            }
            None => return,
        };
        if empty {
            if let Some(tag) = self.tags.remove(&id) {
                self.ids.remove(&tag.name);
            }
        }
    }

    /// Snapshot of the slots currently carrying `name`.
    pub(crate) fn members(&self, name: &str) -> Vec<usize> {
        self.ids
            .get(name)
            .and_then(|id| self.tags.get(id))
            .map(|tag| tag.members.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Human-readable names for the given ids (used to answer "which tags does this key have?").
    pub(crate) fn names(&self, ids: &[u32]) -> Vec<String> {
        ids.iter()
            .filter_map(|id| self.tags.get(id).map(|tag| tag.name.clone()))
            .collect()
    }

    /// Resolves `name` to its id, if the tag currently exists.
    pub(crate) fn resolve(&self, name: &str) -> Option<u32> {
        self.ids.get(name).copied()
    }

    /// Drops every tag. Used by [`Cache::clear`](crate::Cache::clear).
    pub(crate) fn clear(&mut self) {
        self.ids.clear();
        self.tags.clear();
        // next_id is intentionally left alone: ids must stay unique for the process lifetime.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interns_and_forgets_tags_with_no_members() {
        let mut index = TagIndex::default();
        let a = index.intern_all(["alpha", "beta"]);
        assert_eq!(a.len(), 2);
        assert_ne!(a[0], a[1]);

        index.attach(a[0], 7);
        assert!(index.resolve("alpha").is_some());
        assert_eq!(index.members("alpha"), vec![7]);

        index.detach(a[0], 7);
        assert!(index.resolve("alpha").is_none());
        // The id must not be handed out again, otherwise slot 7 would inherit a stale tag.
        let gamma = index.intern_all(["gamma"])[0];
        assert_ne!(gamma, a[0]);
        assert!(index.members("gamma").is_empty());
    }

    #[test]
    fn ignores_unknown_tags() {
        let mut index = TagIndex::default();
        index.detach(99, 1);
        assert!(index.members("nope").is_empty());
        assert!(index.names(&[99]).is_empty());
    }
}
