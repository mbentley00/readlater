package com.readlater.app

import android.app.Application
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.readlater.app.data.ApiClient
import com.readlater.app.data.AppDatabase
import com.readlater.app.data.Repository
import com.readlater.app.data.Settings

/** v1 → v2: reading-time/progress stats columns. */
private val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE articles ADD COLUMN wordCount INTEGER NOT NULL DEFAULT 0")
        db.execSQL("ALTER TABLE articles ADD COLUMN paragraphCount INTEGER NOT NULL DEFAULT 0")
    }
}

/** v2 → v3: listening position tracked separately from the scroll position. */
private val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE articles ADD COLUMN ttsParagraph INTEGER NOT NULL DEFAULT 0")
    }
}

/** v3 → v4: thumbnail image URL for the article list. */
private val MIGRATION_3_4 = object : Migration(3, 4) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE articles ADD COLUMN imageUrl TEXT")
    }
}

/** v4 → v5: original publish date. */
private val MIGRATION_4_5 = object : Migration(4, 5) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE articles ADD COLUMN publishedAt INTEGER")
    }
}

/** v5 → v6: how the article was saved (source), for diagnosing parse failures. */
private val MIGRATION_5_6 = object : Migration(5, 6) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE articles ADD COLUMN source TEXT")
    }
}

/** v6 → v7: when an article was archived, so the Archive tab can order by it.
 *  Backfill already-archived rows with updatedAt — the best available proxy. */
private val MIGRATION_6_7 = object : Migration(6, 7) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("ALTER TABLE articles ADD COLUMN archivedAt INTEGER")
        db.execSQL("UPDATE articles SET archivedAt = updatedAt WHERE archived = 1")
    }
}

/**
 * Application class doubling as a tiny manual DI container.
 * All singletons are created lazily on first use.
 */
class ReadLaterApp : Application() {

    val database: AppDatabase by lazy {
        Room.databaseBuilder(this, AppDatabase::class.java, "readlater.db")
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7)
            .fallbackToDestructiveMigration()
            .build()
    }

    val settings: Settings by lazy { Settings(this) }

    val apiClient: ApiClient by lazy { ApiClient(settings) }

    val repository: Repository by lazy { Repository(database, apiClient, settings) }
}
