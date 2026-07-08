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

/**
 * Application class doubling as a tiny manual DI container.
 * All singletons are created lazily on first use.
 */
class ReadLaterApp : Application() {

    val database: AppDatabase by lazy {
        Room.databaseBuilder(this, AppDatabase::class.java, "readlater.db")
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
            .fallbackToDestructiveMigration()
            .build()
    }

    val settings: Settings by lazy { Settings(this) }

    val apiClient: ApiClient by lazy { ApiClient(settings) }

    val repository: Repository by lazy { Repository(database, apiClient, settings) }
}
