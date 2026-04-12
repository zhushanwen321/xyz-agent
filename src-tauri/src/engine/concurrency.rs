use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct ConcurrencyManager {
    // 使用 Arc<Semaphore> 以便 acquire_owned 返回 OwnedSemaphorePermit
    semaphore: Arc<Semaphore>,
    active_count: Arc<AtomicUsize>,
}

impl ConcurrencyManager {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            active_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn acquire(&self) -> Result<ConcurrencyPermit, String> {
        let permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "concurrency semaphore closed")?;
        self.active_count.fetch_add(1, Ordering::Relaxed);
        Ok(ConcurrencyPermit {
            _permit: permit,
            active_count: self.active_count.clone(),
        })
    }

    pub fn active_count(&self) -> usize {
        self.active_count.load(Ordering::Relaxed)
    }
}

pub struct ConcurrencyPermit {
    _permit: tokio::sync::OwnedSemaphorePermit,
    active_count: Arc<AtomicUsize>,
}

impl Drop for ConcurrencyPermit {
    fn drop(&mut self) {
        self.active_count.fetch_sub(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn allows_up_to_max_concurrent() {
        let mgr = ConcurrencyManager::new(2);
        let p1 = mgr.acquire().await.unwrap();
        let p2 = mgr.acquire().await.unwrap();

        // 第 3 个 permit 应该阻塞，直到释放一个
        let mgr_clone = mgr.clone();
        let handle = tokio::spawn(async move { mgr_clone.acquire().await });

        drop(p1);
        let p3 = handle.await.unwrap().unwrap();
        drop(p2);
        drop(p3);
    }

    #[test]
    fn reports_active_count() {
        let mgr = ConcurrencyManager::new(3);
        assert_eq!(mgr.active_count(), 0);
    }

    #[tokio::test]
    async fn permit_drop_decrements_count() {
        let mgr = ConcurrencyManager::new(2);
        let p1 = mgr.acquire().await.unwrap();
        assert_eq!(mgr.active_count(), 1);
        drop(p1);
        assert_eq!(mgr.active_count(), 0);
    }
}
